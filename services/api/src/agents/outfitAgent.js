import { generateJson } from './gemini.js';

const SYSTEM = `You are the Outfit Agent for a fashion sustainability MVP.
Analyze the clothing visible in the image(s).
If multiple frames from a short video are provided, merge them into one outfit reading
(prefer consistent garments across frames; ignore blurry/occluded frames).
Guess materials only when reasonable; mark uncertainty clearly.
Focus on wearable fashion items, not industrial hazards.
Return JSON with this shape:
{
  "items": string[],
  "materialsGuess": string[],
  "scene": string,
  "labels": string[],
  "confidence": number
}`;

export async function analyzeOutfit({ imageBase64, mimeType, frames = null }) {
  const multi = Array.isArray(frames) && frames.length > 1;
  return generateJson({
    system: SYSTEM,
    user: multi
      ? 'Identify the outfit and likely materials across these video frames. Return one merged outfit analysis.'
      : 'Identify the outfit and likely materials in this snapshot.',
    imageBase64,
    mimeType,
    frames,
  });
}
