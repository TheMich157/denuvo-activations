/**
 * Automatic screenshot verification using OCR.
 * Multi-language: checks for game folder Properties and WUB "Windows updates paused".
 * Supports: EN, DE, FR, ES, IT, PT, RU, PL, SK, NL, ZH, JA.
 * Traineddata stored in data/ folder.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESSDATA_PATH = join(__dirname, '..', '..', 'data');

// Game folder Properties - localized terms (Windows Explorer context menu)
const PROPERTIES_PATTERNS = [
  /propert[iy1]es/i,          // EN (OCR: i/y/1)
  /eigenschaften/i,           // DE
  /propri[eé]t[eé]s/i,        // FR
  /propiedades/i,             // ES
  /propriet[aà]/i,            // IT
  /propriedades/i,            // PT
  /свойства/i,                // RU
  /w[lł]a[sś]ciwo[sś]ci/i,   // PL
  /vlastnost/i,               // SK, CZ (Vlastnosti)
  /属性|プロパティ/i,          // ZH/JA
  /file\s*folder|type:\s*file\s*folder/i,  // Properties dialog "Type: File folder"
  /size\s*on\s*disk|contains:?\s*\d+\s*files/i,  // Properties dialog fields
];

// WUB (Windows Update Blocker) - "updates paused" or equivalent
const WUB_PATTERNS = [
  /windows\s*updates?\s*paused/i,
  /updates?\s*paused/i,
  /\bwub\b/i,
  /windows\s*update\s*blocker|update\s*blocker/i,
  /\bblocker\b/i,             // WUB window title often shows "Blocker"
  /update[s]?\s*paus[iíeé]/i,
  /(windows[- ]?)?updates?\s*pausiert/i,   // DE
  /updates?\s*wstrzymane/i,                 // PL
  /mise\s*[aà]\s*jour\s*.*paus/i,          // FR
  /actualizaci[oó]n\s*.*paus/i,            // ES
  /aggiornamenti\s*.*sospes/i,             // IT
  /atualiza[cç][aã]o\s*.*paus/i,           // PT
  /(windows\s*)?updates?\s*gepauzeerd/i,   // NL
  /pozastavene\s*aktualizacie/i,           // SK (Pozastavene Aktualizacie)
  /aktualiz[aá]ci[ae]\s*.*pozastaven/i,    // SK, CZ
  /pozastaven[eé]\s*.*aktualiz/i,          // SK, CZ
  /vypn[uú][tť]\s*aktualiz/i,              // SK (Vypnúť aktualizácie = disable updates)
  /[uú]rove[nň]\s*slu[zž]by|slu[zž]ieb/i,  // SK Úroveň služby, služieb (WUB specific)
  /možnosti\s*windows|windows\s*aktualiz/i, // SK Možnosti Windows aktualizácií
  /aktualiz[aá]ci[eéí]|[ao]liz[aá]ci/i,   // SK aktualizácie, alizácií (OCR may drop chars)
  /暂停|已暂停|更新.*暂停/i,                // ZH
  /一時停止|更新.*停止/i,                   // JA
];

const OCR_LANGS = ['eng', 'deu', 'fra', 'spa', 'ita', 'por', 'rus', 'pol', 'slk', 'chi_sim', 'jpn'];

function matchesAny(text, patterns) {
  if (!text || typeof text !== 'string') return false;
  const noAccents = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return patterns.some((p) => p.test(text) || p.test(noAccents));
}

/**
 * @param {string} imageUrl - URL of the screenshot (Discord attachment)
 * @returns {Promise<{ verified: boolean; hasProperties: boolean; hasWub: boolean; text?: string; error?: string }>}
 */
export async function verifyScreenshot(imageUrl) {
  let worker;
  try {
    const { createWorker } = await import('tesseract.js');
    worker = await createWorker(OCR_LANGS, 1, {
      logger: () => {},
      langPath: TESSDATA_PATH,
      gzip: false,
    });
    const { data } = await worker.recognize(imageUrl);
    const text = (data?.text || '').replace(/\s+/g, ' ').trim();
    await worker.terminate();

    const hasProperties = matchesAny(text, PROPERTIES_PATTERNS);
    const hasWub = matchesAny(text, WUB_PATTERNS);

    return {
      verified: hasProperties && hasWub,
      hasProperties,
      hasWub,
      text: text.slice(0, 500),
    };
  } catch (err) {
    if (worker) {
      try {
        await worker.terminate();
      } catch {}
    }
    return {
      verified: false,
      hasProperties: false,
      hasWub: false,
      error: err?.message || String(err),
    };
  }
}
