const API_BASE = import.meta.env.VITE_API_BASE || '/api';

const lobby = document.getElementById('lobby');
const roomEl = document.getElementById('room');
const lobbyError = document.getElementById('lobbyError');
const roomIdLabel = document.getElementById('roomIdLabel');
const videoStatus = document.getElementById('videoStatus');
const analysisStatus = document.getElementById('analysisStatus');
const demoVideoNote = document.getElementById('demoVideoNote');
const uploadVideoNote = document.getElementById('uploadVideoNote');
const publisherEl = document.getElementById('publisher');
const localPreview = document.getElementById('localPreview');
const uploadedPreview = document.getElementById('uploadedPreview');
const snapCanvas = document.getElementById('snapCanvas');
const videoFileInput = document.getElementById('videoFileInput');
const uploadVideoBtn = document.getElementById('uploadVideoBtn');
const resumeLiveBtn = document.getElementById('resumeLiveBtn');
const nowPane = publisherEl?.closest('.pane');
const defaultDemoNote =
  demoVideoNote?.textContent ||
  'Vonage keys not set — using camera preview only (demo mode).';

let roomId = null;
let ws = null;
let session = null;
let publisher = null;
let previewStream = null;
let snapshotTimer = null;
let analyzing = false;
let uploadMode = false;
let uploadedObjectUrl = null;
let pendingLobbyUpload = false;
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

  if (pendingLobbyUpload) {
    pendingLobbyUpload = false;
    // Defer so the room UI paints before the file picker
    setTimeout(() => videoFileInput.click(), 50);
  } else {
    startSnapshotLoop();
  }
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
      analysisStatus.textContent = msg.source === 'video' ? 'Video analyzing…' : 'Analyzing…';
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
    try {
      await startCameraPreview();
      videoStatus.textContent = 'Preview';
      demoVideoNote.hidden = false;
    } catch (err) {
      console.warn('Camera preview unavailable', err);
      videoStatus.textContent = pendingLobbyUpload ? 'Upload' : 'No camera';
      demoVideoNote.hidden = false;
      demoVideoNote.textContent = pendingLobbyUpload
        ? 'Camera optional for video upload — pick a file to analyze.'
        : 'Camera unavailable — use Upload video, or allow camera access and rejoin.';
    }
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
  if (!roomId || analyzing || uploadMode) return;
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
  if (uploadMode) return;
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

function clearUploadedVideo() {
  if (uploadedObjectUrl) {
    URL.revokeObjectURL(uploadedObjectUrl);
    uploadedObjectUrl = null;
  }
  uploadedPreview.removeAttribute('src');
  uploadedPreview.hidden = true;
  uploadedPreview.classList.remove('visible');
  uploadedPreview.load();
  uploadVideoNote.hidden = true;
  resumeLiveBtn.hidden = true;
  nowPane?.classList.remove('upload-mode');
  uploadMode = false;
  videoFileInput.value = '';
}

function enterUploadMode(file) {
  stopSnapshotLoop();
  clearUploadedVideo();
  uploadMode = true;

  uploadedObjectUrl = URL.createObjectURL(file);
  uploadedPreview.src = uploadedObjectUrl;
  uploadedPreview.hidden = false;
  uploadedPreview.classList.add('visible');
  nowPane?.classList.add('upload-mode');
  uploadVideoNote.hidden = false;
  resumeLiveBtn.hidden = false;
  demoVideoNote.hidden = true;
  videoStatus.textContent = 'Uploaded';
}

function resumeLiveMode() {
  clearUploadedVideo();
  if (previewStream || session) {
    videoStatus.textContent = publisher ? 'Live' : 'Preview';
    demoVideoNote.textContent = defaultDemoNote;
    demoVideoNote.hidden = Boolean(publisher);
  } else {
    videoStatus.textContent = 'No camera';
    demoVideoNote.textContent =
      'Camera unavailable — use Upload video, or allow camera access and rejoin.';
    demoVideoNote.hidden = false;
  }
  startSnapshotLoop();
}

/**
 * Sample a few JPEG stills across the clip so the Outfit Agent sees motion
 * without uploading the full video blob.
 */
async function extractFramesFromVideo(file, { count = 3, quality = 0.72 } = {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not read video file'));
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const times =
      duration < 0.4
        ? [0]
        : Array.from({ length: count }, (_, i) => {
            const t = ((i + 1) / (count + 1)) * duration;
            return Math.min(Math.max(t, 0), Math.max(duration - 0.05, 0));
          });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const frames = [];

    for (const time of times) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        const onSeeked = () => {
          video.removeEventListener('seeked', onSeeked);
          resolve();
        };
        video.addEventListener('seeked', onSeeked);
        video.onerror = () => reject(new Error('Video seek failed'));
        try {
          video.currentTime = time;
        } catch (err) {
          reject(err);
        }
      });

      const w = video.videoWidth || 640;
      const h = video.videoHeight || 480;
      if (!w || !h) continue;

      const maxEdge = 960;
      const scale = Math.min(1, maxEdge / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // eslint-disable-next-line no-await-in-loop
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob) frames.push(blob);
    }

    if (!frames.length) throw new Error('No frames could be extracted from the video');
    return frames;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
}

async function analyzeUploadedVideo(file) {
  if (!roomId || analyzing) return;
  if (!file || !file.type.startsWith('video/')) {
    throw new Error('Please choose a video file (mp4, webm, mov, …)');
  }
  // Soft guard — client still extracts small JPEGs; huge files just take longer to decode
  if (file.size > 80 * 1024 * 1024) {
    throw new Error('Video is too large (max ~80MB). Try a shorter clip.');
  }

  analyzing = true;
  enterUploadMode(file);
  uploadVideoBtn.disabled = true;
  analysisStatus.textContent = 'Sampling video…';
  analysisStatus.className = 'pill warn';

  try {
    const frames = await extractFramesFromVideo(file, { count: 3 });
    analysisStatus.textContent = 'Video analyzing…';

    const form = new FormData();
    frames.forEach((blob, i) => form.append('frames', blob, `frame-${i + 1}.jpg`));

    const result = await api(`/rooms/${roomId}/analyze-video`, { method: 'POST', body: form });
    renderAnalysis(result);
  } catch (err) {
    console.warn('Video analysis failed:', err.message || err);
    analysisStatus.textContent = 'Error';
    analysisStatus.className = 'pill warn';
    throw err;
  } finally {
    analyzing = false;
    uploadVideoBtn.disabled = false;
  }
}

function renderAnalysis(data) {
  const fromVideo = data.source === 'video';
  analysisStatus.textContent = data.demo ? 'Demo' : fromVideo ? 'Video updated' : 'Updated';
  analysisStatus.className = 'pill';

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
  clearUploadedVideo();
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
document.getElementById('lobbyUploadBtn').addEventListener('click', () => {
  pendingLobbyUpload = true;
  createRoom().catch((err) => {
    pendingLobbyUpload = false;
    showError(err.message);
  });
});
document.getElementById('analyzeBtn').addEventListener('click', () => {
  analyzeFrame();
});
uploadVideoBtn.addEventListener('click', () => {
  videoFileInput.click();
});
resumeLiveBtn.addEventListener('click', () => {
  resumeLiveMode();
});
videoFileInput.addEventListener('change', () => {
  const file = videoFileInput.files?.[0];
  if (!file) return;
  analyzeUploadedVideo(file).catch((err) => {
    if (lobby.hidden) {
      analysisStatus.textContent = err.message || 'Error';
      analysisStatus.className = 'pill warn';
    } else {
      showError(err.message);
    }
  });
});
document.getElementById('leaveBtn').addEventListener('click', () => {
  leaveRoom();
});

const params = new URLSearchParams(location.search);
if (params.get('room')) {
  enterRoom(params.get('room')).catch((err) => showError(err.message));
}
