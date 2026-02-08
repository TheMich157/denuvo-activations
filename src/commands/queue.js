import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { getUserActiveRequests, getQueuePosition } from '../services/requests.js';
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

  const lines = [];
  for (const req of requests) {
    const ref = `#${req.id.slice(0, 8).toUpperCase()}`;
    if (req.status === 'in_progress') {
      const activator = req.issuer_id ? `<@${req.issuer_id}>` : 'unassigned';
      lines.push(`🟢 **${req.game_name}** (${ref}) — **In progress** with ${activator}`);
    } else {
      const pos = getQueuePosition(req.id);
      if (pos) {
        const est = pos.position <= 1 ? 'Next up' : `~${pos.position * 10} min`;
        lines.push(`🟡 **${req.game_name}** (${ref}) — Position **#${pos.position}** of ${pos.total} • Est: ${est}`);
      } else {
        lines.push(`🟡 **${req.game_name}** (${ref}) — Pending`);
      }
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('📋 Your Activation Queue')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${requests.length} active request${requests.length !== 1 ? 's' : ''} • Estimates are approximate` })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
