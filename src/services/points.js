import { db, scheduleSave } from '../db/index.js';
import { isValidDiscordId, isValidPointsAmount } from '../utils/validate.js';

export function getBalance(userId) {
  if (!isValidDiscordId(userId)) return 0;
  ensureUser(userId);
  const row = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
  return row?.points ?? 0;
}

function ensureUser(userId) {
  db.prepare(`
    INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING
  `).run(userId);
}

export function addPoints(userId, amount, type, referenceId = null) {
  if (!isValidDiscordId(userId)) throw new Error('Invalid user ID');
  if (!isValidPointsAmount(amount)) throw new Error('Invalid points amount');
  ensureUser(userId);
  db.prepare(`
    UPDATE users SET points = points + ?, updated_at = datetime('now') WHERE id = ?
  `).run(amount, userId);
  db.prepare(`
    INSERT INTO point_transactions (user_id, amount, type, reference_id) VALUES (?, ?, ?, ?)
  `).run(userId, amount, type, referenceId);
  scheduleSave();
}

export function deductPoints(userId, amount, type, referenceId = null) {
  if (!isValidDiscordId(userId)) return false;
  if (!isValidPointsAmount(amount)) return false;
  ensureUser(userId);
  const balance = getBalance(userId);
  if (balance < amount) return false;
  db.prepare(`
    UPDATE users SET points = points - ?, updated_at = datetime('now') WHERE id = ?
  `).run(amount, userId);
  db.prepare(`
    INSERT INTO point_transactions (user_id, amount, type, reference_id) VALUES (?, ?, ?, ?)
  `).run(userId, -amount, type, referenceId);
  scheduleSave();
  return true;
}

export function transferPoints(fromId, toId, amount, referenceId = null) {
  if (deductPoints(fromId, amount, 'transfer_out', referenceId)) {
    addPoints(toId, amount, 'transfer_in', referenceId);
    return true;
  }
  return false;
}
