import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getPanel, clearPanel, setClosedInfo, scheduleAutoReopen } from '../services/panel.js';
import { buildPanelMessagePayload } from './ticketpanel.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';

/**
 * Build the "maintenance / closed" embed.
 * @param {{ reopenAt?: number; closedBy?: string }} opts
 */
function buildClosedEmbed({ reopenAt, closedBy } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0xf0b232)
    .setTitle('🛠️ Game Activation Center — Maintenance')
    .setDescription(
      'The activation panel is **temporarily closed** for maintenance. New requests cannot be opened right now.'
    );

  if (reopenAt) {
    const ts = Math.floor(reopenAt / 1000);
    embed.addFields({
      name: '⏰ Estimated return',
      value: `The panel will **automatically reopen** <t:${ts}:R> (<t:${ts}:f>).`,
      inline: false,
    });
  } else {
    embed.addFields({
      name: '⏰ Return time',
      value: 'No ETA — an activator will reopen the panel manually with `/ticketpanel`.',
      inline: false,
    });
  }

  embed.addFields(
    {
      name: '✨ Need to request a game?',
      value: 'Please wait until the panel is back up. You\'ll be able to request games again once it\'s active.',
      inline: false,
    },
    {
      name: '🔧 Activators',
      value: 'Run **`/ticketpanel`** at any time to bring the panel back early. The new panel will automatically replace this maintenance message.',
      inline: false,
    }
  );

  if (closedBy) {
    embed.setFooter({ text: `Panel closed by ${closedBy} • Will be back soon` });
  } else {
    embed.setFooter({ text: 'Panel under maintenance • Will be back soon' });
  }

  return embed.setTimestamp();
}

/** Parse a human-friendly duration string like "30m", "2h", "1h30m" into milliseconds. */
function parseDuration(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  let total = 0;
  const hourMatch = s.match(/(\d+)\s*h/);
  const minMatch = s.match(/(\d+)\s*m/);
  if (hourMatch) total += parseInt(hourMatch[1], 10) * 60 * 60 * 1000;
  if (minMatch) total += parseInt(minMatch[1], 10) * 60 * 1000;
  if (total === 0 && /^\d+$/.test(s)) total = parseInt(s, 10) * 60 * 1000; // bare number = minutes
  return total > 0 ? Math.min(total, 24 * 60 * 60 * 1000) : null; // cap at 24h
}

export const data = new SlashCommandBuilder()
  .setName('closepanel')
  .setDescription('Close the ticket panel for maintenance (Activator only)')
  .setContexts(0)
  .addStringOption((o) =>
    o
      .setName('duration')
      .setDescription('How long to close? e.g. "30m", "2h", "1h30m". Leave empty = no auto-reopen.')
      .setRequired(false)
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can close the panel.', flags: MessageFlags.Ephemeral });
  }

  const panel = getPanel();
  if (!panel) {
    return interaction.reply({ content: 'No active panel to close.', flags: MessageFlags.Ephemeral });
  }

  const durationStr = interaction.options.getString('duration');
  const durationMs = parseDuration(durationStr);
  const reopenAt = durationMs ? Date.now() + durationMs : null;
  const closedBy = interaction.user.displayName || interaction.user.username;
  const channelId = panel.channel_id;

  // Edit existing panel message → maintenance embed
  let closedMsgId = null;
  try {
    const channel = await interaction.client.channels.fetch(panel.channel_id).catch(() => null);
    if (channel?.isTextBased()) {
      const msg = await channel.messages.fetch(panel.message_id).catch(() => null);
      if (msg?.editable) {
        await msg.edit({ embeds: [buildClosedEmbed({ reopenAt, closedBy })], components: [] });
        closedMsgId = msg.id;
      } else if (msg) {
        await msg.delete().catch(() => {});
      }
    }
  } catch {}

  clearPanel();
  setClosedInfo({ channelId, messageId: closedMsgId, reopenAt });

  // Schedule auto-reopen
  if (reopenAt && durationMs) {
    scheduleAutoReopen(interaction.client, interaction.guildId, durationMs, buildPanelMessagePayload);
  }

  const timeText = reopenAt
    ? ` The panel will **automatically reopen** <t:${Math.floor(reopenAt / 1000)}:R>.`
    : '';
  await interaction.reply({
    content: `🛠️ **Panel closed for maintenance.**${timeText} Use \`/ticketpanel\` to reopen early.`,
    flags: MessageFlags.Ephemeral,
  });
}
