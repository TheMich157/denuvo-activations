import { detect } from './detector.js';
import { checkGameNameInScreenshot } from './gameMatch.js';
import { extractText as tesseractExtract } from './providers/tesseract.js';
import { extractText as groqExtract } from './providers/groq.js';

const PROVIDERS = [
  { name: 'groq', extract: groqExtract, needsKey: 'GROQ_API_KEY' },
  { name: 'tesseract', extract: tesseractExtract, needsKey: null },
];

/**
 * @param {string} imageUrl - URL of the screenshot (Discord attachment)
 * @param {string} [expectedGameName] - Game name for this ticket (e.g. "Hogwarts Legacy"); if provided, screenshot must show this game folder, not another game
 * @returns {Promise<{ verified: boolean; hasProperties: boolean; hasWub: boolean; gameMismatch?: { detectedGame: string } | { expectedNotFound: true }; provider?: string; text?: string; error?: string }>}
 */
export async function verifyScreenshot(imageUrl, expectedGameName = '') {
  let lastError = null;
  let lastProvider = null;

  for (const provider of PROVIDERS) {
    if (provider.needsKey && !process.env[provider.needsKey]) continue;
    lastProvider = provider.name;
    const result = await provider.extract(imageUrl);
    if (result.error) {
      lastError = result.error;
      continue;
    }
    const text = result.text || '';
    const { hasProperties, hasWub } = detect(text);

    if (expectedGameName && text.length >= 3) {
      const gameCheck = checkGameNameInScreenshot(text, expectedGameName);
      if (!gameCheck.ok) {
        return {
          verified: false,
          hasProperties,
          hasWub,
          gameMismatch: gameCheck.detectedGame
            ? { detectedGame: gameCheck.detectedGame }
            : { expectedNotFound: true },
          provider: provider.name,
          text: text.slice(0, 500),
        };
      }
    }

    return {
      verified: hasProperties && hasWub,
      hasProperties,
      hasWub,
      provider: provider.name,
      text: text.slice(0, 500),
    };
  }

  return {
    verified: false,
    hasProperties: false,
    hasWub: false,
    error: lastError || 'No extraction provider available',
    provider: lastProvider,
  };
}
