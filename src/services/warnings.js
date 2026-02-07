import { db, scheduleSave } from '../db/index.js';
import { addBlacklist } from './blacklist.js';

const AUTO_BLACKLIST_THRESHOLD = 3;

/**
 * Add a warning to a user.
 * @returns {{ warningId: number; totalWarnings: number; autoBlacklisted: boolean }}
 */
export function addWarning(userId, reason, issuedBy) {
  db.prepare(`
    INSERT INTO warnings (user_id, reason, issued_by) VALUES (?, ?, ?)
  `).run(userId, reason, issuedBy);
  scheduleSave();
  const row = db.prepare('SELECT last_insert_rowid() AS id').get();
  const total = getWarningCount(userId);
  let autoBlacklisted = false;
  if (total >= AUTO_BLACKLIST_THRESHOLD) {
    addBlacklist(userId, issuedBy, `Auto-blacklisted: ${total} warnings`);
    autoBlacklisted = true;
  }
  return { warningId: row?.id, totalWarnings: total, autoBlacklisted };
}

/**
 * Get all warnings for a user.
 */
export function getWarnings(userId) {
  return db.prepare('SELECT * FROM warnings WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

/**
 * Get warning count for a user.
 */
export function getWarningCount(userId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM warnings WHERE user_id = ?').get(userId);
  return row?.n ?? 0;
}

/**
 * Remove a specific warning.
 */
export function removeWarning(warningId) {
  const before = db.prepare('SELECT 1 FROM warnings WHERE id = ?').get(warningId);
  if (!before) return false;
  db.prepare('DELETE FROM warnings WHERE id = ?').run(warningId);
  scheduleSave();
  return true;
}

/**
 * Clear all warnings for a user.
 */
export function clearWarnings(userId) {
  const count = getWarningCount(userId);
  db.prepare('DELETE FROM warnings WHERE user_id = ?').run(userId);
  scheduleSave();
  return count;
}
