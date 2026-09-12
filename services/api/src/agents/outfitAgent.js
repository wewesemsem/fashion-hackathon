import { generateJson } from './gemini.js';

const SYSTEM = `You are the Outfit Agent for a fashion sustainability MVP.
Analyze the clothing visible in the image.
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

export async function analyzeOutfit({ imageBase64, mimeType }) {
  return generateJson({
    system: SYSTEM,
    user: 'Identify the outfit and likely materials in this snapshot.',
    imageBase64,
    mimeType,
  });
}
