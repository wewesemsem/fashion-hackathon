import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import { createVonageSession, createVonageToken, isVonageConfigured } from './vonage.js';
import { runFashionPipeline } from './agents/orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});
/** Multi-frame uploads from client-side video sampling (JPEG stills). */
const uploadVideoFrames = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024, files: 6 },
}).array('frames', 6);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

/** @type {Map<string, { sessionId: string | null, createdAt: number }>} */
const rooms = new Map();

/** @type {Map<string, Set<import('ws').WebSocket>>} */
const roomSockets = new Map();

function getRoomClients(roomId) {
  if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
  return roomSockets.get(roomId);
}

function broadcast(roomId, payload) {
  const clients = getRoomClients(roomId);
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

const api = express.Router();

api.get('/health', (_req, res) => {
  res.json({
    ok: true,
    vonage: isVonageConfigured(),
    gemini: Boolean(process.env.GEMINI_API_KEY),
  });
});

api.post('/rooms', async (_req, res) => {
  try {
    const roomId = nanoid(10);
    let sessionId = null;

    if (isVonageConfigured()) {
      sessionId = await createVonageSession();
    } else {
      sessionId = `demo-session-${roomId}`;
    }

    rooms.set(roomId, { sessionId, createdAt: Date.now() });
    res.json({ roomId, joinPath: `/room/${roomId}` });
  } catch (err) {
    console.error('create room failed', err);
    res.status(500).json({ error: 'Failed to create room', detail: String(err.message || err) });
  }
});

api.post('/rooms/:id/token', async (req, res) => {
  try {
    const room = rooms.get(req.params.id);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    const role = req.body?.role === 'moderator' ? 'moderator' : 'publisher';
    const name = req.body?.name || `guest-${nanoid(4)}`;

    if (!isVonageConfigured()) {
      return res.json({
        demo: true,
        applicationId: process.env.VONAGE_APPLICATION_ID || 'demo-app',
        sessionId: room.sessionId,
        token: `demo-token-${nanoid(8)}`,
        roomId: req.params.id,
        name,
      });
    }

    const token = await createVonageToken(room.sessionId, { role, data: name });
    res.json({
      applicationId: process.env.VONAGE_APPLICATION_ID,
      sessionId: room.sessionId,
      token,
      roomId: req.params.id,
      name,
    });
  } catch (err) {
    console.error('token failed', err);
    res.status(500).json({ error: 'Failed to create token', detail: String(err.message || err) });
  }
});

api.post('/rooms/:id/analyze', upload.single('frame'), async (req, res) => {
  try {
    const roomId = req.params.id;
    const room = rooms.get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });

    let imageBase64;
    let mimeType = 'image/jpeg';

    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
      mimeType = req.file.mimetype || 'image/jpeg';
    } else if (req.body?.imageBase64) {
      imageBase64 = String(req.body.imageBase64).replace(/^data:image\/\w+;base64,/, '');
      mimeType = req.body.mimeType || 'image/jpeg';
    } else {
      return res.status(400).json({ error: 'Missing frame image' });
    }

    broadcast(roomId, { type: 'analyzing', source: 'live', timestamp: new Date().toISOString() });

    const result = await runFashionPipeline({ imageBase64, mimeType, source: 'live' });
    const payload = { type: 'analysis', ...result };
    broadcast(roomId, payload);
    res.json(payload);
  } catch (err) {
    console.error('analyze failed', err);
    const message = String(err.message || err);
    broadcast(req.params.id, { type: 'error', message });
    res.status(500).json({ error: 'Analysis failed', detail: message });
  }
});

/**
 * Analyze an uploaded video via sampled JPEG frames (client extracts stills).
 * Reuses the same MAS pipeline + WS contract as live snapshots.
 */
api.post('/rooms/:id/analyze-video', (req, res) => {
  uploadVideoFrames(req, res, async (err) => {
    if (err) {
      console.error('video frame upload failed', err);
      return res.status(400).json({
        error: 'Invalid video frames upload',
        detail: String(err.message || err),
      });
    }

    try {
      const roomId = req.params.id;
      const room = rooms.get(roomId);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const files = Array.isArray(req.files) ? req.files : [];
      let frames = files
        .filter((f) => f?.buffer?.length)
        .map((f) => ({
          imageBase64: f.buffer.toString('base64'),
          mimeType: f.mimetype || 'image/jpeg',
        }));

      if (!frames.length && Array.isArray(req.body?.frames)) {
        frames = req.body.frames
          .map((f) => ({
            imageBase64: String(f.imageBase64 || '').replace(/^data:image\/\w+;base64,/, ''),
            mimeType: f.mimeType || 'image/jpeg',
          }))
          .filter((f) => f.imageBase64);
      }

      if (!frames.length) {
        return res.status(400).json({ error: 'Missing video frames (upload field: frames)' });
      }

      // Cap to keep Gemini latency reasonable for demos
      frames = frames.slice(0, 4);

      broadcast(roomId, {
        type: 'analyzing',
        source: 'video',
        frameCount: frames.length,
        timestamp: new Date().toISOString(),
      });

      const result = await runFashionPipeline({
        imageBase64: frames[0].imageBase64,
        mimeType: frames[0].mimeType,
        frames,
        source: 'video',
      });
      const payload = { type: 'analysis', ...result };
      broadcast(roomId, payload);
      res.json(payload);
    } catch (analyzeErr) {
      console.error('analyze-video failed', analyzeErr);
      const message = String(analyzeErr.message || analyzeErr);
      broadcast(req.params.id, { type: 'error', message });
      res.status(500).json({ error: 'Video analysis failed', detail: message });
    }
  });
});

// Same-origin prod uses /api/*; local Vite can proxy with or without strip.
app.use('/api', api);
app.use(api);

const webDistCandidates = [
  path.resolve(__dirname, '../../../apps/web/dist'),
  path.resolve(process.cwd(), 'apps/web/dist'),
  path.resolve(process.cwd(), '../web/dist'),
  path.resolve(process.cwd(), '../../apps/web/dist'),
];
const webDist = webDistCandidates.find((p) => fs.existsSync(path.join(p, 'index.html')));

if (webDist) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/ws' || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(webDist, 'index.html'));
  });
  console.log(`Serving web UI from ${webDist}`);
} else {
  console.log('No web dist found — API-only mode (run apps/web Vite for local UI)');
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const roomId = url.searchParams.get('roomId');
  if (!roomId || !rooms.has(roomId)) {
    ws.close(4000, 'Invalid room');
    return;
  }

  getRoomClients(roomId).add(ws);
  ws.send(JSON.stringify({ type: 'joined', roomId }));

  ws.on('close', () => {
    getRoomClients(roomId).delete(ws);
  });
});

const port = Number(process.env.PORT || 8787);
server.listen(port, () => {
  console.log(`Fashion risk API listening on http://localhost:${port}`);
  console.log(`Vonage configured: ${isVonageConfigured()}`);
  console.log(`Gemini configured: ${Boolean(process.env.GEMINI_API_KEY)}`);
});
