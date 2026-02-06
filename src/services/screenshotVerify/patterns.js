/**
 * Detection patterns for screenshot verification.
 * Organized by category; add patterns here to extend detection.
 */

// ─── Game folder Properties dialog ───────────────────────────────────────────
export const PROPERTIES_PATTERNS = [
  // English
  /propert[iy1]es/i,
  /file\s*folder|type:\s*file\s*folder/i,
  /size\s*on\s*disk|contains:?\s*\d+\s*files/i,
  /attributes:?\s*read[- ]?only/i,
  // German
  /eigenschaften/i,
  // French
  /propri[eé]t[eé]s/i,
  // Spanish
  /propiedades/i,
  // Italian
  /propriet[aà]/i,
  // Portuguese
  /propriedades/i,
  // Russian
  /свойства/i,
  // Polish
  /w[lł]a[sś]ciwo[sś]ci/i,
  // Slovak, Czech
  /vlastnost/i,
  // Chinese, Japanese
  /属性|プロパティ/i,
  // Steam path indicators (Properties often shows Steam path)
  /steamapps\s*[\\\/]\s*common/i,
  /program\s*files\s*[\\\/]\s*steam/i,
];

// ─── WUB (Windows Update Blocker) ────────────────────────────────────────────
export const WUB_PATTERNS = [
  // English – core UI text
  /disable\s*updates?|enable\s*updates?/i,
  /apply\s*now/i,
  /\bstatus\b/i,
  /protect\s*services?\s*settings?/i,
  /windows\s*update\s*blocker\s*v?1\.?0/i,
  /windows\s*updates?\s*paused/i,
  /updates?\s*paused/i,
  /\bwub\b/i,
  /windows\s*update\s*blocker|update\s*blocker/i,
  /\bblocker\b/i,
  /update[s]?\s*paus[iíeé]/i,
  // German
  /(windows[- ]?)?updates?\s*pausiert/i,
  // Polish
  /updates?\s*wstrzymane/i,
  // French
  /mise\s*[aà]\s*jour\s*.*paus/i,
  // Spanish
  /actualizaci[oó]n\s*.*paus/i,
  // Italian
  /aggiornamenti\s*.*sospes/i,
  // Portuguese
  /atualiza[cç][aã]o\s*.*paus/i,
  // Dutch
  /(windows\s*)?updates?\s*gepauzeerd/i,
  // Slovak, Czech
  /pozastavene\s*aktualizacie/i,
  /aktualiz[aá]ci[ae]\s*.*pozastaven/i,
  /pozastaven[eé]\s*.*aktualiz/i,
  /vypn[uú][tť]\s*aktualiz/i,
  /[uú]rove[nň]\s*slu[zž]by|slu[zž]ieb/i,
  /možnosti\s*windows|windows\s*aktualiz/i,
  /aktualiz[aá]ci[eéí]|[ao]liz[aá]ci/i,
  // Chinese
  /暂停|已暂停|更新.*暂停/i,
  // Japanese
  /一時停止|更新.*停止/i,
];
