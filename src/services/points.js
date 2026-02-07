import { db, scheduleSave } from '../db/index.js';
import { isValidDiscordId, isValidPointsAmount } from '../utils/validate.js';

const MAX_TRANSACTION_TYPE_LENGTH = 100;

export function getBalance(userId) {
  if (!isValidDiscordId(userId)) return 0;
  ensureUser(userId);
  const row = db.prepare('SELECT points FROM users WHERE id = ?').get(String(userId));
  return row?.points ?? 0;
}

function ensureUser(userId) {
  db.prepare(`
    INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING
  `).run(String(userId));
}

function truncateType(type) {
  const s = typeof type === 'string' ? type : String(type ?? '');
  return s.length > MAX_TRANSACTION_TYPE_LENGTH ? s.slice(0, MAX_TRANSACTION_TYPE_LENGTH - 3) + '...' : s;
}

export function addPoints(userId, amount, type, referenceId = null) {
  if (!isValidDiscordId(userId)) throw new Error('Invalid user ID');
  if (!isValidPointsAmount(amount)) throw new Error('Invalid points amount');
  ensureUser(userId);
  const safeType = truncateType(type) || 'credit';
  db.prepare(`
    UPDATE users SET points = points + ?, updated_at = datetime('now') WHERE id = ?
  `).run(amount, String(userId));
  db.prepare(`
    INSERT INTO point_transactions (user_id, amount, type, reference_id) VALUES (?, ?, ?, ?)
  `).run(String(userId), amount, safeType, referenceId ? String(referenceId) : null);
  scheduleSave();
}

export function deductPoints(userId, amount, type, referenceId = null) {
  if (!isValidDiscordId(userId)) return false;
  if (!isValidPointsAmount(amount)) return false;
  ensureUser(userId);
  const balance = getBalance(userId);
  if (balance < amount) return false;
  const safeType = truncateType(type) || 'debit';
  db.prepare(`
    UPDATE users SET points = points - ?, updated_at = datetime('now') WHERE id = ?
  `).run(amount, String(userId));
  db.prepare(`
    INSERT INTO point_transactions (user_id, amount, type, reference_id) VALUES (?, ?, ?, ?)
  `).run(String(userId), -amount, safeType, referenceId ? String(referenceId) : null);
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
