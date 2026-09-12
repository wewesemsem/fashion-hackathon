import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Auth } from '@vonage/auth';
import { Video } from '@vonage/video';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let videoClient = null;

function resolvePrivateKeyPath(keyPath) {
  if (!keyPath) return null;
  const candidates = [
    keyPath,
    path.resolve(process.cwd(), keyPath),
    path.resolve(process.cwd(), '..', keyPath),
    path.resolve(__dirname, '..', keyPath),
    path.resolve(__dirname, '../../', keyPath),
    path.resolve(__dirname, '../vonage.key'),
    path.resolve(__dirname, '../../vonage.key'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return p;
      }
    } catch (_) {}
  }
  return null;
}

function getPrivateKey() {
  if (process.env.VONAGE_PRIVATE_KEY) {
    return process.env.VONAGE_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  const keyPath = process.env.VONAGE_PRIVATE_KEY_PATH || './vonage.key';
  const resolved = resolvePrivateKeyPath(keyPath);
  if (resolved) {
    try {
      return fs.readFileSync(resolved, 'utf8');
    } catch (err) {
      console.warn(`[Vonage] Failed to read private key at ${resolved}:`, err.message);
      return null;
    }
  }
  return null;
}

export function isVonageConfigured() {
  if (!process.env.VONAGE_APPLICATION_ID) return false;
  const key = getPrivateKey();
  return Boolean(key && key.trim());
}

function getVideoClient() {
  if (videoClient) return videoClient;
  if (!isVonageConfigured()) {
    throw new Error('Vonage is not configured');
  }

  const auth = new Auth({
    applicationId: process.env.VONAGE_APPLICATION_ID,
    privateKey: getPrivateKey(),
  });

  videoClient = new Video(auth);
  return videoClient;
}

export async function createVonageSession() {
  const client = getVideoClient();
  const session = await client.createSession({ mediaMode: 'routed' });
  return session.sessionId;
}

export async function createVonageToken(sessionId, { role = 'publisher', data = '' } = {}) {
  const client = getVideoClient();
  return client.generateClientToken(sessionId, {
    role,
    data,
    expireTime: Math.floor(Date.now() / 1000) + 60 * 60 * 6,
  });
}
