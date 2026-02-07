import { db, scheduleSave } from '../db/index.js';
import { getGameByAppId, getGameDisplayName } from '../utils/games.js';
import { EmbedBuilder } from 'discord.js';
import { getUserTierInfo, TIERS } from './tiers.js';

export function joinWaitlist(userId, gameAppId) {
  db.prepare(
    `INSERT OR IGNORE INTO game_waitlist (user_id, game_app_id) VALUES (?, ?)`
  ).run(String(userId), gameAppId);
  scheduleSave();
}

export function leaveWaitlist(userId, gameAppId) {
  db.prepare(
    `DELETE FROM game_waitlist WHERE user_id = ? AND game_app_id = ?`
  ).run(String(userId), gameAppId);
  scheduleSave();
}

export function isOnWaitlist(userId, gameAppId) {
  const row = db.prepare(
    'SELECT 1 FROM game_waitlist WHERE user_id = ? AND game_app_id = ?'
  ).get(String(userId), gameAppId);
  return !!row;
}

export function getWaitlistForGame(gameAppId) {
  return db.prepare(
    'SELECT user_id FROM game_waitlist WHERE game_app_id = ? ORDER BY created_at ASC'
  ).all(gameAppId);
}

/**
 * Get the full waitlist grouped by game.
 * @returns {{ game_app_id: number; users: string[] }[]}
 */
export function getFullWaitlist() {
  const rows = db.prepare(
    'SELECT game_app_id, user_id, created_at FROM game_waitlist ORDER BY game_app_id, created_at ASC'
  ).all();
  const grouped = new Map();
  for (const r of rows) {
    if (!grouped.has(r.game_app_id)) grouped.set(r.game_app_id, []);
    grouped.get(r.game_app_id).push(r.user_id);
  }
  return [...grouped.entries()].map(([game_app_id, users]) => ({ game_app_id, users }));
}

/**
 * Remove a specific user from a specific game waitlist.
 */
export function removeFromWaitlist(userId, gameAppId) {
  const before = db.prepare('SELECT 1 FROM game_waitlist WHERE user_id = ? AND game_app_id = ?').get(String(userId), gameAppId);
  if (!before) return false;
  db.prepare('DELETE FROM game_waitlist WHERE user_id = ? AND game_app_id = ?').run(String(userId), gameAppId);
  scheduleSave();
  return true;
}

/**
 * Remove a user from ALL waitlists.
 */
export function removeUserFromAllWaitlists(userId) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM game_waitlist WHERE user_id = ?').get(String(userId));
  db.prepare('DELETE FROM game_waitlist WHERE user_id = ?').run(String(userId));
  scheduleSave();
  return count?.n ?? 0;
}

/**
 * Get total waitlist count.
 */
export function getWaitlistCount() {
  const row = db.prepare('SELECT COUNT(*) AS n FROM game_waitlist').get();
  return row?.n ?? 0;
}

/**
 * Notify all users on the waitlist for a game that stock was added, then clear them.
 * @param {import('discord.js').Client} client
 * @param {number} gameAppId
 */
export async function notifyWaitlistAndClear(client, gameAppId) {
  const waiters = getWaitlistForGame(gameAppId);
  if (waiters.length === 0) return;

  const game = getGameByAppId(gameAppId);
  const name = game ? getGameDisplayName(game) : `App ${gameAppId}`;

  // Sort by tier priority (higher tiers notified first)
  waiters.sort((a, b) => {
    const tierA = getUserTierInfo(a.user_id);
    const tierB = getUserTierInfo(b.user_id);
    return (TIERS[tierB.tier]?.level ?? 0) - (TIERS[tierA.tier]?.level ?? 0);
  });

  for (const w of waiters) {
    const tierInfo = getUserTierInfo(w.user_id);
    const tierNote = tierInfo.tier !== 'none'
      ? `\n${TIERS[tierInfo.tier].emoji} As a **${TIERS[tierInfo.tier].label}** supporter, you're getting this notification first!`
      : '';
    const embed = new EmbedBuilder()
      .setColor(0x57f287)
      .setTitle('🔔 Game back in stock!')
      .setDescription(`**${name}** is back in stock! Head to the ticket panel to request it.${tierNote}`)
      .setFooter({ text: 'You were on the waitlist for this game' })
      .setTimestamp();
    try {
      const user = await client.users.fetch(w.user_id).catch(() => null);
      if (user) await user.send({ embeds: [embed] }).catch(() => {});
    } catch {}
  }

  db.prepare('DELETE FROM game_waitlist WHERE game_app_id = ?').run(gameAppId);
  scheduleSave();
}
