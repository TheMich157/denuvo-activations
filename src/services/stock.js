import { loadGames } from '../utils/games.js';
import { getActivatorsForGame, getAvailableStockForGame } from './activators.js';

const MAX_SELECT_OPTIONS = 25;
const MAX_SELECT_MENUS = 5;

/**
 * Returns games that are in stock (at least one activator with capacity).
 */
export function getGamesInStock() {
  const allGames = loadGames();
  return allGames.filter((g) => {
    const activators = getActivatorsForGame(g.appId);
    return activators.length > 0;
  });
}

/**
 * Returns true if game is in stock.
 */
export function isGameInStock(appId) {
  const activators = getActivatorsForGame(appId);
  return activators.length > 0;
}

/**
 * Returns stock count (available activation slots) for a game.
 * 1 account with capacity = 5, decreases as activations complete.
 */
export function getStockCount(appId) {
  return getAvailableStockForGame(appId);
}

/**
 * Build select menu options for ALL games from list, sorted A–Z, split into chunks of 25.
 * Each chunk placeholder shows letter range (e.g. "A – E", "F – K").
 */
export function buildStockSelectMenus() {
  const allGames = loadGames();
  const sorted = [...allGames].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const chunks = [];
  for (let i = 0; i < sorted.length && chunks.length < MAX_SELECT_MENUS; i += MAX_SELECT_OPTIONS) {
    chunks.push(sorted.slice(i, i + MAX_SELECT_OPTIONS));
  }
  return chunks;
}

export function getChunkLabel(chunk) {
  if (chunk.length === 0) return 'Select a game';
  const first = chunk[0].name.trim()[0]?.toUpperCase() ?? 'A';
  const last = chunk[chunk.length - 1].name.trim()[0]?.toUpperCase() ?? 'Z';
  return first === last ? first : `${first} – ${last}`;
}
