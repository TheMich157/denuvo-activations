import { db, scheduleSave } from '../db/index.js';
import { isValidDiscordId } from '../utils/validate.js';

export function addStrike(userId, reason = 'token_invalid') {
  if (!isValidDiscordId(userId)) return 0;
  db.prepare(`
    INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING
  `).run(userId);
  db.prepare(`
    UPDATE users SET strikes = strikes + 1, updated_at = datetime('now') WHERE id = ?
  `).run(userId);
  scheduleSave();
  return getStrikes(userId);
}

export function getStrikes(userId) {
  if (!isValidDiscordId(userId)) return 0;
  const row = db.prepare('SELECT strikes FROM users WHERE id = ?').get(userId);
  return row?.strikes ?? 0;
}

export function clearStrikes(userId) {
  if (!isValidDiscordId(userId)) return;
  db.prepare('UPDATE users SET strikes = 0, updated_at = datetime(\'now\') WHERE id = ?').run(userId);
  scheduleSave();
}
