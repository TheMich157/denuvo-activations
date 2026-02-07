import { db, scheduleSave } from '../db/index.js';
import { getGameByAppId, getGameDisplayName } from '../utils/games.js';
import { EmbedBuilder } from 'discord.js';

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
 * Notify all users on the waitlist for a game that stock was added, then clear them.
 * @param {import('discord.js').Client} client
 * @param {number} gameAppId
 */
export async function notifyWaitlistAndClear(client, gameAppId) {
  const waiters = getWaitlistForGame(gameAppId);
  if (waiters.length === 0) return;

  const game = getGameByAppId(gameAppId);
  const name = game ? getGameDisplayName(game) : `App ${gameAppId}`;

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🔔 Game back in stock!')
    .setDescription(`**${name}** is back in stock! Head to the ticket panel to request it.`)
    .setFooter({ text: 'You were on the waitlist for this game' })
    .setTimestamp();

  for (const w of waiters) {
    try {
      const user = await client.users.fetch(w.user_id).catch(() => null);
      if (user) await user.send({ embeds: [embed] }).catch(() => {});
    } catch {}
  }

  db.prepare('DELETE FROM game_waitlist WHERE game_app_id = ?').run(gameAppId);
  scheduleSave();
}
