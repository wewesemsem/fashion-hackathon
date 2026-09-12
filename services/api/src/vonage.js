import fs from 'fs';
import { Auth } from '@vonage/auth';
import { Video } from '@vonage/video';

let videoClient = null;

export function isVonageConfigured() {
  return Boolean(
    process.env.VONAGE_APPLICATION_ID &&
      (process.env.VONAGE_PRIVATE_KEY || process.env.VONAGE_PRIVATE_KEY_PATH)
  );
}

function getPrivateKey() {
  if (process.env.VONAGE_PRIVATE_KEY) {
    return process.env.VONAGE_PRIVATE_KEY.replace(/\\n/g, '\n');
  }
  if (process.env.VONAGE_PRIVATE_KEY_PATH) {
    return fs.readFileSync(process.env.VONAGE_PRIVATE_KEY_PATH, 'utf8');
  }
  return null;
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
