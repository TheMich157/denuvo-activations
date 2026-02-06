/**
 * Screenshot verification service.
 * Tries providers in order: Groq Vision (if key set) → Tesseract OCR.
 * Detects: game folder Properties dialog + WUB (Windows Update Blocker).
 */

import { detect } from './detector.js';
import { extractText as tesseractExtract } from './providers/tesseract.js';
import { extractText as groqExtract } from './providers/groq.js';

const PROVIDERS = [
  { name: 'groq', extract: groqExtract, needsKey: 'GROQ_API_KEY' },
  { name: 'tesseract', extract: tesseractExtract, needsKey: null },
];

/**
 * @param {string} imageUrl - URL of the screenshot (Discord attachment)
 * @returns {Promise<{ verified: boolean; hasProperties: boolean; hasWub: boolean; provider?: string; text?: string; error?: string }>}
 */
export async function verifyScreenshot(imageUrl) {
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
