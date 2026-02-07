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



let panelClient = null;
let panelPayloadBuilder = null;

export function setPanelClient(client, buildPayload) {
  panelClient = client;
  panelPayloadBuilder = buildPayload;
}


export async function triggerPanelSync() {
  if (!panelClient || !panelPayloadBuilder) return;
  try {
    await syncPanelMessage(panelClient, panelPayloadBuilder());
  } catch {}
}


let closedInfo = null;

/** @param {{ channelId: string; messageId: string | null; reopenAt: number | null }} info */
export function setClosedInfo(info) {
  closedInfo = info ?? null;
}

/** @returns {{ channelId: string; messageId: string | null; reopenAt: number | null } | null} */
export function getClosedInfo() {
  return closedInfo;
}

export function clearClosedInfo() {
  closedInfo = null;
}

// ---- Closed message cleanup & reopen timer ----

let reopenTimer = null;

/**
 * Delete the closed/maintenance message if it exists.
 */
export async function deleteClosedMessage(client) {
  const closed = getClosedInfo();
  if (!closed?.messageId || !closed?.channelId) { clearClosedInfo(); return; }
  try {
    const ch = await client.channels.fetch(closed.channelId).catch(() => null);
    if (ch?.isTextBased?.()) {
      const msg = await ch.messages.fetch(closed.messageId).catch(() => null);
      if (msg?.deletable) await msg.delete();
    }
  } catch (err) {
    log('deleteClosedMessage failed:', err?.message);
  }
  clearClosedInfo();
}

/**
 * Cancel any pending auto-reopen timer.
 */
export function cancelReopenTimer() {
  if (reopenTimer) { clearTimeout(reopenTimer); reopenTimer = null; }
}

/**
 * Schedule auto-reopen after durationMs. When it fires, deletes the maintenance
 * message and posts a fresh panel.
 * @param {import('discord.js').Client} client
 * @param {string} guildId
 * @param {number} durationMs
 * @param {() => { embeds: unknown[]; components: unknown[] }} buildPayload - function that builds the panel payload (avoids circular dep)
 */
export function scheduleAutoReopen(client, guildId, durationMs, buildPayload) {
  cancelReopenTimer();
  reopenTimer = setTimeout(async () => {
    reopenTimer = null;
    try {
      // Remember channel before deleting closed info
      const closed = getClosedInfo();
      const channelId = closed?.channelId;
      await deleteClosedMessage(client);
      if (!channelId) return;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isTextBased?.()) return;
      const payload = buildPayload();
      const msg = await channel.send(payload);
      setPanel(guildId, channel.id, msg.id);
      log('Panel auto-reopened after maintenance timer');
    } catch (err) {
      log('autoReopenPanel failed:', err?.message);
    }
  }, durationMs);
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
