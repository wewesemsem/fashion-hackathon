import { generateJson, generateImageDataUrl } from './gemini.js';

const SYSTEM = `You are the Alternative Outfit Agent.
Propose a healthier, ethically made, and environmentally friendly alternative outfit
that preserves the same aesthetic/vibe as the detected look while actively mitigating the
identified risks across Wearers (comfort, biomechanics, skin safety), Makers/Workers (safe dyeing, fair labor, reduced dust/chemical hazards), and the Planet (biodegradable fibers, circularity, low water/carbon footprint).
Return JSON:
{
  "title": string,
  "items": string[],
  "whyHealthier": string,
  "whyGreener": string,
  "imagePrompt": string
}`;

export async function proposeAlternative(outfit, risks) {
  const alternative = await generateJson({
    system: SYSTEM,
    user: `Current outfit:\n${JSON.stringify(outfit, null, 2)}\n\nRisks:\n${JSON.stringify(risks, null, 2)}\n\nPropose a better alternative outfit.`,
  });

  const imagePrompt =
    alternative.imagePrompt ||
    `Clean product-style photo of a full outfit: ${(alternative.items || []).join(', ')}. Soft natural light, no text, fashion editorial.`;

  const imageDataUrl = await generateImageDataUrl(imagePrompt);

  return {
    title: alternative.title || 'Healthier eco swap',
    items: alternative.items || [],
    whyHealthier: alternative.whyHealthier || '',
    whyGreener: alternative.whyGreener || '',
    imagePromptUsed: imagePrompt,
    imageUrl: imageDataUrl,
  };
}
