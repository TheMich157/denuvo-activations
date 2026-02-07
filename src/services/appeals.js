import { db, scheduleSave } from '../db/index.js';

/**
 * Submit a ban appeal.
 */
export function submitAppeal(userId, reason) {
  // Check if user already has a pending appeal
  const pending = db.prepare(`SELECT id FROM ban_appeals WHERE user_id = ? AND status = 'pending'`).get(userId);
  if (pending) return { ok: false, error: 'You already have a pending appeal.', appealId: pending.id };
  db.prepare(`INSERT INTO ban_appeals (user_id, reason) VALUES (?, ?)`).run(userId, reason);
  scheduleSave();
  const row = db.prepare('SELECT last_insert_rowid() AS id').get();
  return { ok: true, appealId: row?.id };
}

/**
 * Get all pending appeals.
 */
export function getPendingAppeals() {
  return db.prepare(`SELECT * FROM ban_appeals WHERE status = 'pending' ORDER BY created_at ASC`).all();
}

/**
 * Get a specific appeal.
 */
export function getAppeal(appealId) {
  return db.prepare('SELECT * FROM ban_appeals WHERE id = ?').get(appealId);
}

/**
 * Get appeals for a user.
 */
export function getUserAppeals(userId) {
  return db.prepare('SELECT * FROM ban_appeals WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

/**
 * Approve an appeal.
 */
export function approveAppeal(appealId, reviewedBy, note = null) {
  db.prepare(`
    UPDATE ban_appeals SET status = 'approved', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(reviewedBy, note, appealId);
  scheduleSave();
}

/**
 * Deny an appeal.
 */
export function denyAppeal(appealId, reviewedBy, note = null) {
  db.prepare(`
    UPDATE ban_appeals SET status = 'denied', reviewed_by = ?, review_note = ?, reviewed_at = datetime('now')
    WHERE id = ?
  `).run(reviewedBy, note, appealId);
  scheduleSave();
}
