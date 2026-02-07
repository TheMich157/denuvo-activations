import { PROPERTIES_PATTERNS, WUB_PATTERNS } from './patterns.js';

function matchesAny(text, patterns) {
  if (!text || typeof text !== 'string') return false;
  const noAccents = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return patterns.some((p) => p.test(text) || p.test(noAccents));
}

/**
 * @param {string} text - Extracted text from image
 * @returns {{ hasProperties: boolean; hasWub: boolean }}
 */
export function detect(text) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim();
  return {
    hasProperties: matchesAny(normalized, PROPERTIES_PATTERNS),
    hasWub: matchesAny(normalized, WUB_PATTERNS),
  };
}
