import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getUserActiveRequests, getQueuePosition, getAvgCompletionMinutes } from '../services/requests.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('See your position in the activation queue')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const requests = getUserActiveRequests(userId);

  if (requests.length === 0) {
    return interaction.reply({
      content: 'You have no active requests in the queue.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const avgMins = getAvgCompletionMinutes() || 10;
  const lines = [];
  for (const req of requests) {
    const ref = `#${req.id.slice(0, 8).toUpperCase()}`;
    const createdTs = Math.floor(new Date(req.created_at).getTime() / 1000);
    if (req.status === 'in_progress') {
      const activator = req.issuer_id ? `<@${req.issuer_id}>` : 'unassigned';
      const elapsed = Math.round((Date.now() - new Date(req.created_at).getTime()) / 60000);
      lines.push(`🟢 **${req.game_name}** (${ref})\n\u2003\u2003**In progress** with ${activator} • ${elapsed} min elapsed`);
    } else {
      const pos = getQueuePosition(req.id);
      if (pos) {
        const estMins = pos.position <= 1 ? avgMins : pos.position * avgMins;
        const estLabel = estMins < 60 ? `~${estMins} min` : `~${Math.round(estMins / 60 * 10) / 10}h`;
        const bar = buildProgressBar(pos.position, pos.total);
        lines.push(
          `🟡 **${req.game_name}** (${ref})\n` +
          `\u2003\u2003Position **#${pos.position}** of ${pos.total} ${bar}\n` +
          `\u2003\u2003⏱️ Est. wait: **${estLabel}** • Opened <t:${createdTs}:R>`
        );
      } else {
        lines.push(`🟡 **${req.game_name}** (${ref}) — Pending`);
      }
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Your Activation Queue')
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `${requests.length} active request${requests.length !== 1 ? 's' : ''} • Avg completion: ${avgMins} min • Estimates are approximate` })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

function buildProgressBar(position, total) {
  if (total <= 1) return '▓░░░░░░░░░';
  const pct = Math.max(0, 1 - (position - 1) / total);
  const filled = Math.round(pct * 10);
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}
