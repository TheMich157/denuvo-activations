import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isValidAppId } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let gamesCache = null;

/**
 * Load games only from list.json. Normalizes appId to integer and drops invalid/duplicate entries.
 */
export function loadGames() {
  if (gamesCache) return gamesCache;
  const path = join(__dirname, '../../list.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const raw = Array.isArray(data.games) ? data.games : [];
  const seen = new Set();
  gamesCache = raw
    .filter((g) => g && (g.name || g.appId != null))
    .map((g) => {
      const appId = typeof g.appId === 'number' ? g.appId : parseInt(g.appId, 10);
      const highDemand = g.highDemand === true || g.highDemand === 'true';
      return { name: String(g.name || '').trim(), appId, highDemand };
    })
    .filter((g) => g.name && isValidAppId(g.appId) && !seen.has(g.appId) && seen.add(g.appId));
  return gamesCache;
}

export function clearGamesCache() {
  gamesCache = null;
}

export function searchGames(query) {
  const games = loadGames();
  if (!query || query.trim().length < 2) {
    return games.slice(0, 25);
  }
  const q = query.toLowerCase();
  return games
    .filter((g) => g.name.toLowerCase().includes(q))
    .slice(0, 25);
}

export function getGameByAppId(appId) {
  const games = loadGames();
  const id = typeof appId === 'number' ? appId : parseInt(appId, 10);
  if (!isValidAppId(id)) return null;
  return games.find((g) => g.appId === id) || null;
}

const COOLDOWN_HOURS_NORMAL = 24;
const COOLDOWN_HOURS_HIGH_DEMAND = 48;

/** Cooldown in hours for normal users (high-demand games = 2 days, others = 24h). */
export function getCooldownHours(appId) {
  const game = getGameByAppId(appId);
  return game?.highDemand ? COOLDOWN_HOURS_HIGH_DEMAND : COOLDOWN_HOURS_NORMAL;
}

export function isHighDemandGame(appId) {
  const game = getGameByAppId(appId);
  return game?.highDemand === true;
}

/** Display name with 🔥 for high-demand games. */
export function getGameDisplayName(game) {
  if (!game) return '';
  return game.highDemand ? `${game.name} 🔥` : game.name;
}
