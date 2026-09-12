const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const lobby = document.getElementById('lobby');
const roomEl = document.getElementById('room');
const lobbyError = document.getElementById('lobbyError');
const roomIdLabel = document.getElementById('roomIdLabel');
const videoStatus = document.getElementById('videoStatus');
const analysisStatus = document.getElementById('analysisStatus');
const demoVideoNote = document.getElementById('demoVideoNote');
const publisherEl = document.getElementById('publisher');
const localPreview = document.getElementById('localPreview');
const snapCanvas = document.getElementById('snapCanvas');

let roomId = null;
let ws = null;
let session = null;
let publisher = null;
let previewStream = null;
let snapshotTimer = null;
let analyzing = false;
let OT = null;

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || data.error || res.statusText);
  return data;
}

function showError(message) {
  lobbyError.hidden = !message;
  lobbyError.textContent = message || '';
}

async function loadVonageSdk() {
  try {
    const mod = await import('@vonage/client-sdk-video');
    OT = mod.default || mod.OT || mod;
    return Boolean(OT?.initSession);
  } catch (err) {
    console.warn('Vonage web SDK unavailable', err);
    return false;
  }
}

async function createRoom() {
  showError('');
  const data = await api('/rooms', { method: 'POST' });
  await enterRoom(data.roomId);
}

async function joinRoom() {
  showError('');
  const id = document.getElementById('roomInput').value.trim();
  if (!id) return showError('Enter a room code');
  await enterRoom(id);
}

async function enterRoom(id) {
  roomId = id;
  const tokenPayload = await api(`/rooms/${id}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'guest' }),
  });

  lobby.hidden = true;
  roomEl.hidden = false;
  roomIdLabel.textContent = id;
  history.replaceState({}, '', `?room=${id}`);

  connectWs(id);
  await startVideo(tokenPayload);
  startSnapshotLoop();
}

function connectWs(id) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl =
    import.meta.env.VITE_WS_URL ||
    `${proto}://${location.host}/ws?roomId=${encodeURIComponent(id)}`;

  ws = new WebSocket(wsUrl);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'analyzing') {
      analysisStatus.textContent = 'Analyzing…';
      analysisStatus.className = 'pill warn';
    }
    if (msg.type === 'analysis') {
      renderAnalysis(msg);
    }
    if (msg.type === 'error') {
      analysisStatus.textContent = 'Error';
      analysisStatus.className = 'pill warn';
    }
  };
}

async function startVideo(creds) {
  const hasSdk = await loadVonageSdk();
  const isDemo = creds.demo || String(creds.token || '').startsWith('demo-');

  if (!hasSdk || isDemo) {
    await startCameraPreview();
    videoStatus.textContent = 'Preview';
    demoVideoNote.hidden = false;
    return;
  }

  demoVideoNote.hidden = true;
  session = OT.initSession(creds.applicationId, creds.sessionId);

  session.on('streamCreated', (event) => {
    const subEl = document.getElementById('subscriber');
    subEl.hidden = false;
    session.subscribe(event.stream, subEl, { insertMode: 'append', width: '100%', height: '100%' });
  });

  publisher = OT.initPublisher(publisherEl, {
    insertMode: 'append',
    width: '100%',
    height: '100%',
    mirror: true,
  });

  await new Promise((resolve, reject) => {
    session.connect(creds.token, (err) => (err ? reject(err) : resolve()));
  });
  session.publish(publisher);
  videoStatus.textContent = 'Live';
}

async function startCameraPreview() {
  previewStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user' },
    audio: false,
  });
  localPreview.srcObject = previewStream;
  localPreview.hidden = false;
  localPreview.classList.add('visible');
  publisherEl.innerHTML = '';
  publisherEl.appendChild(localPreview);
}

async function waitForVideoReady(maxWaitMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    let video = publisherEl.querySelector('video') || localPreview;
    if (video && video.readyState >= 2 && (video.videoWidth > 0 || video.readyState >= 3)) {
      return video;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function getSnapshotBlob() {
  const video = await waitForVideoReady(2500);
  if (!video) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const w = video.videoWidth || 640;
    const h = video.videoHeight || 480;
    snapCanvas.width = w;
    snapCanvas.height = h;
    const ctx = snapCanvas.getContext('2d');
    ctx.drawImage(video, 0, 0, w, h);
    snapCanvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Snapshot failed'))),
      'image/jpeg',
      0.72
    );
  });
}

async function analyzeFrame() {
  if (!roomId || analyzing) return;
  analyzing = true;

  try {
    const blob = await getSnapshotBlob();
    if (!blob) {
      // Camera is still initializing, quietly wait for next tick
      return;
    }

    analysisStatus.textContent = 'Analyzing…';
    analysisStatus.className = 'pill warn';

    const form = new FormData();
    form.append('frame', blob, 'frame.jpg');
    const result = await api(`/rooms/${roomId}/analyze`, { method: 'POST', body: form });
    renderAnalysis(result);
  } catch (err) {
    console.warn('Analysis tick failed:', err.message || err);
    analysisStatus.textContent = 'Retry';
    analysisStatus.className = 'pill warn';
  } finally {
    analyzing = false;
  }
}

function startSnapshotLoop() {
  stopSnapshotLoop();
  snapshotTimer = setInterval(() => {
    analyzeFrame();
  }, 5000);
  setTimeout(analyzeFrame, 2000);
}

function stopSnapshotLoop() {
  if (snapshotTimer) clearInterval(snapshotTimer);
  snapshotTimer = null;
}

function renderAnalysis(data) {
  if (data.fallbackNotice) {
    analysisStatus.textContent = 'Fallback';
    analysisStatus.className = 'pill warn';
    analysisStatus.title = data.fallbackNotice;
  } else {
    analysisStatus.textContent = data.demo ? 'Demo' : 'Updated';
    analysisStatus.className = 'pill';
    analysisStatus.title = '';
  }

  const detected = document.getElementById('detected');
  const items = data.detected?.items || [];
  detected.innerHTML = items.length
    ? items.map((i) => `<span class="chip">${escapeHtml(i)}</span>`).join('')
    : '—';

  // Lifecycle hotspot
  const lifecycleBox = document.getElementById('lifecycleBox');
  const lifecycleBadge = document.getElementById('lifecycleBadge');
  const lifecycleSummary = document.getElementById('lifecycleSummary');
  if (data.lifecycleFootprint && lifecycleBox && lifecycleBadge && lifecycleSummary) {
    lifecycleBadge.textContent = data.lifecycleFootprint.primaryStage || 'Full Lifecycle';
    lifecycleSummary.textContent = data.lifecycleFootprint.summary || '';
    lifecycleBox.hidden = false;
  } else if (lifecycleBox) {
    lifecycleBox.hidden = true;
  }

  // 3-Column Risk Matrix
  const wearersList = data.matrix?.wearers || data.health || [];
  const workersList = data.matrix?.workers || data.workerHealth || [];
  const planetList = data.matrix?.planet || data.environment || [];

  const wearersEl = document.getElementById('wearers');
  const workersEl = document.getElementById('workers');
  const planetEl = document.getElementById('planet');

  if (wearersEl) wearersEl.innerHTML = renderRiskCards(wearersList);
  if (workersEl) workersEl.innerHTML = renderRiskCards(workersList);
  if (planetEl) planetEl.innerHTML = renderRiskCards(planetList);

  // Backward compatibility containers if present
  const healthLegacy = document.getElementById('health');
  const envLegacy = document.getElementById('environment');
  if (healthLegacy) healthLegacy.innerHTML = renderRiskCards(wearersList);
  if (envLegacy) envLegacy.innerHTML = renderRiskCards(planetList);

  // Better Choices
  const betterChoicesWrapper = document.getElementById('betterChoicesWrapper');
  const betterChoicesList = document.getElementById('betterChoices');
  if (betterChoicesWrapper && betterChoicesList && Array.isArray(data.betterChoices) && data.betterChoices.length) {
    betterChoicesList.innerHTML = data.betterChoices
      .map((choice) => `<li>${escapeHtml(choice)}</li>`)
      .join('');
    betterChoicesWrapper.hidden = false;
  } else if (betterChoicesWrapper) {
    betterChoicesWrapper.hidden = true;
  }

  // Alternative Outfit
  const alt = data.alternativeOutfit || {};
  const altVisual = document.getElementById('altVisual');
  if (alt.imageUrl) {
    altVisual.innerHTML = `<img src="${alt.imageUrl}" alt="Alternative outfit" />`;
  } else {
    const list = (alt.items || []).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
    altVisual.innerHTML = `
      <div class="alt-card">
        <h3>${escapeHtml(alt.title || 'Alternative outfit')}</h3>
        <ul>${list || '<li>Greener capsule look</li>'}</ul>
      </div>`;
  }

  document.getElementById('altMeta').innerHTML = `
    <p><strong>Why healthier:</strong> ${escapeHtml(alt.whyHealthier || '—')}</p>
    <p><strong>Why greener:</strong> ${escapeHtml(alt.whyGreener || '—')}</p>
  `;
}

function renderRiskCards(list = []) {
  if (!list.length) return '<p class="empty-note">No notable concerns detected.</p>';
  return list
    .map((r) => {
      const severity = escapeHtml(r.severity || 'low');
      const title = escapeHtml(r.title || r.issue || '');
      const detail = escapeHtml(r.detail || '');
      const stageHtml = r.lifecycleStage
        ? `<span class="stage-tag">${escapeHtml(r.lifecycleStage)}</span>`
        : '';

      let sourceHtml = '';
      if (r.source && typeof r.source === 'object') {
        const agency = escapeHtml(r.source.agency || 'Source');
        const citation = escapeHtml(r.source.citation || agency);
        const url = r.source.url ? escapeHtml(r.source.url) : '';
        sourceHtml = url
          ? `<a class="source-tag" href="${url}" target="_blank" rel="noopener noreferrer" title="${citation}">${agency} ↗</a>`
          : `<span class="source-tag" title="${citation}">${agency}</span>`;
      } else if (r.source) {
        const agency = escapeHtml(String(r.source));
        const url = r.sourceUrl ? escapeHtml(r.sourceUrl) : '';
        sourceHtml = url
          ? `<a class="source-tag" href="${url}" target="_blank" rel="noopener noreferrer">${agency} ↗</a>`
          : `<span class="source-tag">${agency}</span>`;
      }

      return `
      <div class="card">
        <div class="card-top">
          <span class="sev ${severity}">${severity}</span>
          ${stageHtml}
        </div>
        <strong>${title}</strong>
        <p>${detail}</p>
        ${sourceHtml ? `<div class="card-footer">${sourceHtml}</div>` : ''}
      </div>`;
    })
    .join('');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function leaveRoom() {
  stopSnapshotLoop();
  if (ws) ws.close();
  if (session) {
    try {
      session.disconnect();
    } catch (_) {}
  }
  if (previewStream) {
    previewStream.getTracks().forEach((t) => t.stop());
    previewStream = null;
  }
  localPreview.srcObject = null;
  localPreview.hidden = true;
  localPreview.classList.remove('visible');
  publisherEl.innerHTML = '';
  roomEl.hidden = true;
  lobby.hidden = false;
  history.replaceState({}, '', '/');
}

document.getElementById('createRoomBtn').addEventListener('click', () => {
  createRoom().catch((err) => showError(err.message));
});
document.getElementById('joinRoomBtn').addEventListener('click', () => {
  joinRoom().catch((err) => showError(err.message));
});
document.getElementById('analyzeBtn').addEventListener('click', () => {
  analyzeFrame();
});
document.getElementById('leaveBtn').addEventListener('click', () => {
  leaveRoom();
});

const params = new URLSearchParams(location.search);
if (params.get('room')) {
  enterRoom(params.get('room')).catch((err) => showError(err.message));
}
