import { EmbedBuilder } from 'discord.js';
import { db } from '../db/index.js';

/**
 * Check if a user has DM notifications enabled.
 */
function hasDMEnabled(userId) {
  try {
    const row = db.prepare('SELECT dm_notifications FROM users WHERE id = ?').get(userId);
    return (row?.dm_notifications ?? 1) === 1;
  } catch {
    return true;
  }
}

/**
 * Check if a user has status update DMs enabled.
 */
function hasStatusDMEnabled(userId) {
  try {
    const row = db.prepare('SELECT dm_notifications, notify_status FROM users WHERE id = ?').get(userId);
    if ((row?.dm_notifications ?? 1) === 0) return false;
    return (row?.notify_status ?? 1) === 1;
  } catch {
    return true;
  }
}

/**
 * Send a status DM to the buyer when their request status changes.
 * @param {import('discord.js').Client} client
 * @param {string} userId
 * @param {'claimed' | 'completed' | 'cancelled' | 'failed'} status
 * @param {{ gameName: string; issuerName?: string }} options
 */
export async function sendStatusDM(client, userId, status, { gameName, issuerName } = {}) {
  try {
    if (!hasStatusDMEnabled(userId)) return false;
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return false;

    const embedMap = {
      claimed: {
        color: 0x5865f2,
        title: '🔄 Request Claimed',
        desc: `Your request for **${gameName}** has been claimed by an activator. They're working on it now.`,
      },
      completed: {
        color: 0x57f287,
        title: '✅ Activation Complete',
        desc: `Your activation for **${gameName}** is complete! Check the ticket channel for your authorization code.`,
      },
      cancelled: {
        color: 0xfee75c,
        title: '🚫 Request Cancelled',
        desc: `Your request for **${gameName}** was cancelled. You can create a new request from the panel.`,
      },
      failed: {
        color: 0xed4245,
        title: '❌ Request Failed',
        desc: `Your request for **${gameName}** could not be completed. You can try again from the panel.`,
      },
    };

    const info = embedMap[status];
    if (!info) return false;

    const embed = new EmbedBuilder()
      .setColor(info.color)
      .setTitle(info.title)
      .setDescription(info.desc)
      .setFooter({ text: 'Game Activation • Use /profile to see your requests' })
      .setTimestamp();

    await user.send({ embeds: [embed] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Notify relevant activators about a new request for their game.
 * @param {import('discord.js').Client} client
 * @param {{ gameName: string; gameAppId: number; buyerId: string; ticketChannelId?: string }} options
 * @param {{ activator_id: string }[]} activators - List of activators who have this game
 */
export async function notifyActivators(client, { gameName, gameAppId, buyerId, ticketChannelId }, activators) {
  if (!activators?.length) return;

  const channelMention = ticketChannelId ? `<#${ticketChannelId}>` : 'the ticket channel';

  for (const a of activators) {
    try {
      if (!hasDMEnabled(a.activator_id)) continue;
      if (a.activator_id === buyerId) continue; // don't DM self

      const user = await client.users.fetch(a.activator_id).catch(() => null);
      if (!user) continue;

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎮 New Activation Request')
        .setDescription(
          `A new request for **${gameName}** needs an activator!\n\n` +
          `Head to ${channelMention} to claim it.`
        )
        .setFooter({ text: 'Game Activation • Claim the request to help' })
        .setTimestamp();

      await user.send({ embeds: [embed] }).catch(() => {});
    } catch {}
  }
}
