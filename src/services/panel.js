import { db, scheduleSave } from '../db/index.js';
import { debug } from '../utils/debug.js';

const log = debug('panel');

export function getPanel() {
  return db.prepare('SELECT guild_id, channel_id, message_id FROM panel WHERE id = 1').get();
}

export function setPanel(guildId, channelId, messageId) {
  db.prepare('INSERT OR REPLACE INTO panel (id, guild_id, channel_id, message_id) VALUES (1, ?, ?, ?)')
    .run(guildId, channelId, messageId);
  scheduleSave();
}

export function clearPanel() {
  db.prepare('DELETE FROM panel WHERE id = 1').run();
  scheduleSave();
}

/**
 * Sync the panel message with current DB state (stock, games).
 * Call on startup so the panel reflects correct state after bot restart.
 * If the message was deleted, clears the panel from DB.
 * @param {import('discord.js').Client} client
 * @param {{ embeds: unknown[]; components: unknown[] }} payload - From buildPanelMessagePayload()
 */
export async function syncPanelMessage(client, payload) {
  const panel = getPanel();
  if (!panel?.channel_id || !panel?.message_id) return;
  try {
    const channel = await client.channels.fetch(panel.channel_id).catch(() => null);
    if (!channel?.isTextBased?.() || channel.isDMBased?.()) {
      log('Panel channel missing or invalid; clearing panel');
      clearPanel();
      return;
    }
    const message = await channel.messages.fetch(panel.message_id).catch(() => null);
    if (!message) {
      log('Panel message missing; clearing panel');
      clearPanel();
      return;
    }
    await message.edit(payload);
  } catch (err) {
    log('Panel sync failed:', err?.message);
    clearPanel();
  }
}
