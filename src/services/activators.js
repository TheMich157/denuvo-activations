import { db, scheduleSave } from '../db/index.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { config } from '../config.js';
import { isValidDiscordId, isValidAppId } from '../utils/validate.js';

export function addActivatorGame(activatorId, gameAppId, gameName, method, credentials = null, stockQuantity = 5) {
  if (!isValidDiscordId(activatorId) || !isValidAppId(gameAppId)) throw new Error('Invalid activator or game ID');
  if (!['manual', 'automated'].includes(method)) throw new Error('Invalid method');
  const q = Math.max(1, Math.min(9999, stockQuantity));
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO activator_games (activator_id, game_app_id, game_name, method, credentials_encrypted, steam_username, stock_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  let encrypted = null;
  let steamUsername = null;
  if (method === 'automated' && credentials) {
    encrypted = encrypt(JSON.stringify(credentials), config.encryptionKey);
    steamUsername = credentials.username ?? null;
  }
  stmt.run(activatorId, gameAppId, gameName, method, encrypted, steamUsername, q);
  scheduleSave();
}

export function addActivatorStock(activatorId, gameAppId, gameName, quantity) {
  if (!isValidDiscordId(activatorId) || !isValidAppId(gameAppId)) throw new Error('Invalid activator or game ID');
  const q = Math.max(1, Math.min(9999, quantity));
  const existing = db.prepare('SELECT id, stock_quantity FROM activator_games WHERE activator_id = ? AND game_app_id = ?')
    .get(activatorId, gameAppId);
  if (existing) {
    db.prepare('UPDATE activator_games SET stock_quantity = stock_quantity + ?, game_name = ? WHERE activator_id = ? AND game_app_id = ?')
      .run(q, gameName, activatorId, gameAppId);
  } else {
    db.prepare(`
      INSERT INTO activator_games (activator_id, game_app_id, game_name, method, stock_quantity)
      VALUES (?, ?, ?, 'manual', ?)
    `).run(activatorId, gameAppId, gameName, q);
  }
  scheduleSave();
}

export function decrementActivatorStock(activatorId, gameAppId) {
  const row = db.prepare(
    'SELECT stock_quantity FROM activator_games WHERE activator_id = ? AND game_app_id = ?'
  ).get(activatorId, gameAppId);
  if (!row || (row.stock_quantity ?? 0) <= 0) return;
  db.prepare(`
    UPDATE activator_games SET stock_quantity = max(0, stock_quantity - 1)
    WHERE activator_id = ? AND game_app_id = ?
  `).run(activatorId, gameAppId);
  const restockAt = new Date(Date.now() + (config.restockHours || 24) * 60 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT INTO stock_restock_queue (activator_id, game_app_id, restock_at) VALUES (?, ?, ?)'
  ).run(activatorId, gameAppId, restockAt);
  scheduleSave();
}

export function removeActivatorStock(activatorId, gameAppId, quantity) {
  if (!isValidDiscordId(activatorId) || !isValidAppId(gameAppId)) throw new Error('Invalid activator or game ID');
  const q = Math.max(1, Math.min(9999, quantity));
  const row = db.prepare(
    'SELECT stock_quantity FROM activator_games WHERE activator_id = ? AND game_app_id = ?'
  ).get(activatorId, gameAppId);
  if (!row) return { ok: false, error: 'You do not have this game in your stock.' };
  const current = row.stock_quantity ?? 0;
  const removed = Math.min(q, current);
  const newQty = Math.max(0, current - q);
  db.prepare(
    'UPDATE activator_games SET stock_quantity = ? WHERE activator_id = ? AND game_app_id = ?'
  ).run(newQty, activatorId, gameAppId);
  if (newQty === 0) {
    db.prepare('DELETE FROM activator_games WHERE activator_id = ? AND game_app_id = ?').run(activatorId, gameAppId);
  }
  scheduleSave();
  return { ok: true, removed, remaining: newQty };
}

export function getActivatorsForGame(gameAppId, excludeOverLimit = true) {
  const rows = db.prepare(`
    SELECT ag.*, u.notify_dm, u.notify_ping
    FROM activator_games ag
    LEFT JOIN users u ON u.id = ag.activator_id
    WHERE ag.game_app_id = ? AND (ag.stock_quantity IS NULL OR ag.stock_quantity > 0)
  `).all(gameAppId);

  if (!excludeOverLimit) return rows;

  const today = new Date().toISOString().slice(0, 10);
  const limit = config.dailyActivationLimit;

  return rows.filter((row) => {
    const steamId = row.steam_username || `manual_${row.activator_id}_${row.game_app_id}`;
    const countRow = db.prepare(`
      SELECT count FROM daily_activations WHERE steam_account_id = ? AND date = ?
    `).get(steamId, today);
    const count = countRow?.count ?? 0;
    return count < limit;
  });
}

export function getActivatorGames(activatorId) {
  return db.prepare(`
    SELECT game_app_id, game_name, method, steam_username, COALESCE(stock_quantity, 5) AS stock_quantity, created_at
    FROM activator_games
    WHERE activator_id = ?
  `).all(activatorId);
}

export function removeActivatorGame(activatorId, gameAppId) {
  db.prepare('DELETE FROM activator_games WHERE activator_id = ? AND game_app_id = ?')
    .run(activatorId, gameAppId);
  scheduleSave();
}

export function incrementDailyActivation(steamAccountId) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO daily_activations (steam_account_id, date, count)
    VALUES (?, ?, 1)
    ON CONFLICT(steam_account_id, date) DO UPDATE SET count = count + 1
  `).run(steamAccountId, today);
  scheduleSave();
}

export function decrementDailyActivation(steamAccountId) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE daily_activations SET count = max(0, count - 1) WHERE steam_account_id = ? AND date = ?
  `).run(steamAccountId, today);
}

export function getDailyCount(steamAccountId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(`
    SELECT count FROM daily_activations WHERE steam_account_id = ? AND date = ?
  `).get(steamAccountId, today);
  return row?.count ?? 0;
}

export function getAvailableStockForGame(gameAppId) {
  const rows = db.prepare(`
    SELECT activator_id, steam_username, COALESCE(stock_quantity, 5) AS qty
    FROM activator_games WHERE game_app_id = ? AND (stock_quantity IS NULL OR stock_quantity > 0)
  `).all(gameAppId);
  const today = new Date().toISOString().slice(0, 10);
  const limit = config.dailyActivationLimit;
  let total = 0;
  for (const row of rows) {
    const steamId = row.steam_username || `manual_${row.activator_id}_${row.game_app_id}`;
    const count = db.prepare(
      'SELECT count FROM daily_activations WHERE steam_account_id = ? AND date = ?'
    ).get(steamId, today);
    const used = count?.count ?? 0;
    const capacity = Math.min(row.qty, Math.max(0, limit - used));
    total += capacity;
  }
  return total;
}

export function processRestockQueue() {
  const rows = db.prepare(
    `SELECT id, activator_id, game_app_id FROM stock_restock_queue WHERE restock_at <= datetime('now')`
  ).all();
  for (const row of rows) {
    db.prepare(
      'UPDATE activator_games SET stock_quantity = COALESCE(stock_quantity, 0) + 1 WHERE activator_id = ? AND game_app_id = ?'
    ).run(row.activator_id, row.game_app_id);
    db.prepare('DELETE FROM stock_restock_queue WHERE id = ?').run(row.id);
  }
  if (rows.length > 0) scheduleSave();
  return rows.length;
}

export function cleanupOldRestockEntries() {
  db.prepare(
    `DELETE FROM stock_restock_queue WHERE restock_at < datetime('now', '-1 hour')`
  ).run();
  db.prepare(
    `DELETE FROM activation_cooldowns WHERE cooldown_until < datetime('now')`
  ).run();
  scheduleSave();
}

export function getPendingRestockCount(activatorId, gameAppId) {
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM stock_restock_queue WHERE activator_id = ? AND game_app_id = ?'
  ).get(activatorId, gameAppId);
  return row?.n ?? 0;
}

export function getNextRestockAt(activatorId, gameAppId) {
  const row = db.prepare(
    'SELECT restock_at FROM stock_restock_queue WHERE activator_id = ? AND game_app_id = ? ORDER BY restock_at ASC LIMIT 1'
  ).get(activatorId, gameAppId);
  return row?.restock_at ?? null;
}

export function getCredentials(activatorId, gameAppId) {
  if (!config.encryptionKey || config.encryptionKey.length < 64) return null;
  try {
    const row = db.prepare(`
      SELECT credentials_encrypted FROM activator_games
      WHERE activator_id = ? AND game_app_id = ? AND method = 'automated'
    `).get(activatorId, gameAppId);
    if (!row?.credentials_encrypted) return null;
    return JSON.parse(decrypt(row.credentials_encrypted, config.encryptionKey));
  } catch {
    return null;
  }
}
