/**
 * Tesseract OCR provider. Uses local traineddata from data/ folder.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESSDATA_PATH = join(__dirname, '..', '..', '..', '..', 'data');

const OCR_LANGS = ['eng', 'deu', 'fra', 'spa', 'ita', 'por', 'rus', 'pol', 'slk', 'chi_sim', 'jpn'];

/**
 * @param {string} imageUrl - URL of the image
 * @returns {Promise<{ text: string } | { error: string }>}
 */
export async function extractText(imageUrl) {
  let worker;
  try {
    const { createWorker } = await import('tesseract.js');
    worker = await createWorker(OCR_LANGS, 1, {
      logger: () => {},
      langPath: TESSDATA_PATH,
      gzip: false,
    });
    const { data } = await worker.recognize(imageUrl);
    await worker.terminate();
    const text = (data?.text || '').replace(/\s+/g, ' ').trim();
    return text ? { text } : { error: 'No text detected in image' };
  } catch (err) {
    if (worker) {
      try {
        await worker.terminate();
      } catch {}
    }
    return { error: err?.message || String(err) };
  }
}
