import { loadGames } from '../../utils/games.js';

/**
 * Normalize a game name for matching in OCR text: lowercase, remove punctuation, collapse spaces.
 * @param {string} name
 * @returns {string}
 */
function normalizeForMatch(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[:®™©\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if the extracted screenshot text matches the expected game (this ticket's game).
 * If another game from our list is clearly visible instead, return a mismatch so we can tell the user.
 * @param {string} extractedText - OCR/extracted text from the screenshot
 * @param {string} expectedGameName - The game this ticket is for (e.g. "Hogwarts Legacy")
 * @returns {{ ok: boolean; detectedGame?: string; expectedNotFound?: boolean }}
 */
export function checkGameNameInScreenshot(extractedText, expectedGameName) {
  const text = (extractedText || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
  if (text.length < 3) return { ok: true };

  const expectedNorm = normalizeForMatch(expectedGameName);
  const expectedTokens = expectedNorm.split(/\s+/).filter((t) => t.length >= 2);

  const games = loadGames();
  if (!games.length) return { ok: true };

  // Sort by name length descending so we match "Black Myth: Wukong" before "Wukong"
  const otherGames = games
    .filter((g) => g.name && normalizeForMatch(g.name) !== expectedNorm)
    .map((g) => ({ name: g.name, norm: normalizeForMatch(g.name) }))
    .filter((g) => g.norm.length >= 2)
    .sort((a, b) => b.norm.length - a.norm.length);

  for (const { name, norm } of otherGames) {
    // Require at least 2 significant words or one long token to avoid false positives
    const tokens = norm.split(/\s+/).filter((t) => t.length >= 2);
    const matchCount = tokens.filter((t) => text.includes(t)).length;
    if (tokens.length >= 2 && matchCount >= 2) {
      return { ok: false, detectedGame: name };
    }
    if (tokens.length === 1 && tokens[0].length >= 4 && text.includes(tokens[0])) {
      return { ok: false, detectedGame: name };
    }
  }

  // Optionally: require expected game to appear (so we don't accept random folder)
  if (expectedTokens.length >= 1) {
    const foundExpected = expectedTokens.some((t) => text.includes(t));
    if (!foundExpected) {
      return { ok: false, expectedNotFound: true };
    }
  }

  return { ok: true };
}
