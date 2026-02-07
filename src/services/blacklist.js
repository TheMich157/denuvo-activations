import { db, scheduleSave } from '../db/index.js';

export function isBlacklisted(userId) {
  if (!userId) return false;
  const row = db.prepare('SELECT user_id FROM blacklist WHERE user_id = ?').get(String(userId));
  return !!row;
}

export function getBlacklistEntry(userId) {
  if (!userId) return null;
  return db.prepare('SELECT * FROM blacklist WHERE user_id = ?').get(String(userId));
}

export function addToBlacklist(userId, reason, addedBy) {
  db.prepare(
    `INSERT OR REPLACE INTO blacklist (user_id, reason, added_by) VALUES (?, ?, ?)`
  ).run(String(userId), reason || null, String(addedBy));
  scheduleSave();
}

export function removeFromBlacklist(userId) {
  db.prepare('DELETE FROM blacklist WHERE user_id = ?').run(String(userId));
  scheduleSave();
}

export function getBlacklistAll() {
  return db.prepare('SELECT * FROM blacklist ORDER BY created_at DESC').all();
}
