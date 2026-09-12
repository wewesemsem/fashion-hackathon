import { GoogleGenerativeAI } from '@google/generative-ai';

export function getGenAI() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is missing');
  return new GoogleGenerativeAI(key);
}

export function getModel(model = process.env.GEMINI_MODEL || 'gemini-3.6-flash') {
  return getGenAI().getGenerativeModel({
    model,
    generationConfig: {
      temperature: 0.4,
      responseMimeType: 'application/json',
    },
  });
}

export async function generateJson({
  system,
  user,
  imageBase64,
  mimeType = 'image/jpeg',
  frames = null,
}) {
  const model = getModel();
  const parts = [];

  if (system) {
    parts.push({ text: `${system}\n\nRespond with valid JSON only.` });
  }

  const media = Array.isArray(frames) && frames.length
    ? frames
    : imageBase64
      ? [{ imageBase64, mimeType }]
      : [];

  for (const frame of media) {
    if (!frame?.imageBase64) continue;
    parts.push({
      inlineData: {
        data: frame.imageBase64,
        mimeType: frame.mimeType || 'image/jpeg',
      },
    });
  }

  parts.push({ text: user });

  const result = await model.generateContent(parts);
  const text = result.response.text();
  return parseJsonLoose(text);
}

export async function generateImageDataUrl(prompt) {
  // Optional: Gemini image generation when available.
  // Falls back to null so UI can render a styled text card.
  const imageModel = process.env.GEMINI_IMAGE_MODEL;
  if (!imageModel || !process.env.GEMINI_API_KEY) return null;

  try {
    const model = getGenAI().getGenerativeModel({ model: imageModel });
    const result = await model.generateContent(prompt);
    const response = result.response;
    const parts = response.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.inlineData?.data) {
        const mime = part.inlineData.mimeType || 'image/png';
        return `data:${mime};base64,${part.inlineData.data}`;
      }
    }
  } catch (err) {
    console.warn('Image generation skipped:', err.message || err);
  }
  return null;
}

function parseJsonLoose(text) {
  const cleaned = String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Model did not return valid JSON');
  }
}
