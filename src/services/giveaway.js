import { db, scheduleSave } from '../db/index.js';
import crypto from 'crypto';

/**
 * Create a giveaway.
 */
export function createGiveaway(gameName, gameAppId, createdBy, endsAt, maxWinners = 1, messageId = null, channelId = null) {
  db.prepare(`
    INSERT INTO giveaways (game_name, game_app_id, created_by, ends_at, max_winners, message_id, channel_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gameName, gameAppId || null, createdBy, endsAt, maxWinners, messageId, channelId);
  scheduleSave();
  const row = db.prepare('SELECT last_insert_rowid() AS id').get();
  return row?.id;
}

export function setGiveawayMessage(giveawayId, messageId, channelId) {
  db.prepare('UPDATE giveaways SET message_id = ?, channel_id = ? WHERE id = ?').run(messageId, channelId, giveawayId);
  scheduleSave();
}

export function getGiveaway(giveawayId) {
  return db.prepare('SELECT * FROM giveaways WHERE id = ?').get(giveawayId);
}

export function getActiveGiveaways() {
  return db.prepare(`SELECT * FROM giveaways WHERE status = 'active' ORDER BY ends_at ASC`).all();
}

export function enterGiveaway(giveawayId, userId) {
  try {
    db.prepare(`INSERT OR IGNORE INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)`).run(giveawayId, userId);
    scheduleSave();
    return true;
  } catch { return false; }
}

export function getEntries(giveawayId) {
  return db.prepare('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?').all(giveawayId);
}

export function getEntryCount(giveawayId) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM giveaway_entries WHERE giveaway_id = ?').get(giveawayId);
  return row?.n ?? 0;
}

export function hasEntered(giveawayId, userId) {
  return !!db.prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?').get(giveawayId, userId);
}

export function endGiveaway(giveawayId, winners) {
  db.prepare(`UPDATE giveaways SET status = 'ended', winners = ? WHERE id = ?`).run(JSON.stringify(winners), giveawayId);
  scheduleSave();
}

/**
 * Pick random winners from entries using Fisher-Yates shuffle (unbiased).
 */
export function pickWinners(giveawayId, count = 1) {
  const entries = getEntries(giveawayId);
  if (entries.length === 0) return [];
  // Fisher-Yates shuffle with crypto.randomInt for fairness
  const arr = [...entries];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, Math.min(count, arr.length)).map((e) => e.user_id);
}
