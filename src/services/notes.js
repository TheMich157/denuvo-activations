import { db, scheduleSave } from '../db/index.js';

/**
 * Add a note to a user.
 */
export function addNote(userId, note, addedBy) {
  db.prepare('INSERT INTO user_notes (user_id, note, added_by) VALUES (?, ?, ?)').run(userId, note, addedBy);
  scheduleSave();
  const row = db.prepare('SELECT last_insert_rowid() AS id').get();
  return row?.id;
}

/**
 * Get all notes for a user.
 */
export function getNotes(userId) {
  return db.prepare('SELECT * FROM user_notes WHERE user_id = ? ORDER BY created_at DESC').all(userId);
}

/**
 * Remove a specific note.
 */
export function removeNote(noteId) {
  const before = db.prepare('SELECT 1 FROM user_notes WHERE id = ?').get(noteId);
  if (!before) return false;
  db.prepare('DELETE FROM user_notes WHERE id = ?').run(noteId);
  scheduleSave();
  return true;
}

/**
 * Get note count for a user.
 */
export function getNoteCount(userId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM user_notes WHERE user_id = ?').get(userId);
  return row?.n ?? 0;
}
