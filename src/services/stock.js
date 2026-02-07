import { loadGames } from '../utils/games.js';
import { getActivatorsForGame, getAvailableStockForGame } from './activators.js';
import { db } from '../db/index.js';

const MAX_SELECT_OPTIONS = 25;
const MAX_SELECT_MENUS = 5;

export function getGamesInStock() {
  const allGames = loadGames();
  return allGames.filter((g) => {
    const activators = getActivatorsForGame(g.appId);
    return activators.length > 0;
  });
}

export function isGameInStock(appId) {
  const activators = getActivatorsForGame(appId);
  return activators.length > 0;
}

export function getStockCount(appId) {
  return getAvailableStockForGame(appId);
}

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

const LOW_STOCK_THRESHOLD = 10;

export function getGlobalStockStats() {
  const allGames = loadGames();
  let totalStock = 0;
  let gamesInStock = 0;
  let lowStockCount = 0;
  let emptyCount = 0;
  for (const g of allGames) {
    const stock = getStockCount(g.appId);
    totalStock += stock;
    if (stock > 0) gamesInStock++;
    if (stock === 0) emptyCount++;
    else if (stock < LOW_STOCK_THRESHOLD) lowStockCount++;
  }
  return {
    totalStock,
    gamesInStock,
    totalGames: allGames.length,
    lowStockCount,
    emptyCount,
  };
}

export function getRestockStats() {
  const in1h = db.prepare(
    `SELECT COUNT(*) AS n FROM stock_restock_queue WHERE restock_at > datetime('now') AND restock_at <= datetime('now', '+1 hour')`
  ).get();
  const in6h = db.prepare(
    `SELECT COUNT(*) AS n FROM stock_restock_queue WHERE restock_at > datetime('now') AND restock_at <= datetime('now', '+6 hours')`
  ).get();
  const in24h = db.prepare(
    `SELECT COUNT(*) AS n FROM stock_restock_queue WHERE restock_at > datetime('now') AND restock_at <= datetime('now', '+24 hours')`
  ).get();
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM stock_restock_queue WHERE restock_at > datetime('now')`
  ).get();
  return {
    in1h: in1h?.n ?? 0,
    in6h: in6h?.n ?? 0,
    in24h: in24h?.n ?? 0,
    total: total?.n ?? 0,
  };
}
