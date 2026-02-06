import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isValidAppId } from './validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let gamesCache = null;

export function loadGames() {
  if (gamesCache) return gamesCache;
  const path = join(__dirname, '../../list.json');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  gamesCache = (data.games || []).filter((g) => g && isValidAppId(g.appId));
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
  return games.find((g) => g.appId === appId);
}
