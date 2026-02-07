import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../db/index.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Top activators by completions and points earned')
  .setContexts(0)
  .addStringOption((o) =>
    o
      .setName('period')
      .setDescription('Time period (default: all-time)')
      .setRequired(false)
      .addChoices(
        { name: 'This month', value: 'month' },
        { name: 'All time', value: 'all' }
      )
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const period = interaction.options.getString('period') ?? 'all';
  const isMonth = period === 'month';
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthISO = monthStart.toISOString();

  const rows = isMonth
    ? db.prepare(`
        SELECT r.issuer_id,
               COUNT(*) AS completions,
               COALESCE(SUM(r.points_charged), 0) AS points_earned
        FROM requests r
        WHERE r.status = 'completed' AND r.issuer_id IS NOT NULL AND r.completed_at >= ?
        GROUP BY r.issuer_id
        ORDER BY completions DESC, points_earned DESC
        LIMIT 15
      `).all(monthISO)
    : db.prepare(`
        SELECT r.issuer_id,
               COUNT(*) AS completions,
               COALESCE(SUM(r.points_charged), 0) AS points_earned
        FROM requests r
        WHERE r.status = 'completed' AND r.issuer_id IS NOT NULL
        GROUP BY r.issuer_id
        ORDER BY completions DESC, points_earned DESC
        LIMIT 15
      `).all();

  if (rows.length === 0) {
    return interaction.reply({
      content: isMonth ? 'No completions this month yet.' : 'No completions recorded yet.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => {
    const rank = medals[i] ?? `**${i + 1}.**`;
    return `${rank} <@${r.issuer_id}> — **${r.completions}** activation${r.completions !== 1 ? 's' : ''} • **${r.points_earned}** pts`;
  });

  const periodLabel = isMonth
    ? `${monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric' })}`
    : 'All time';

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 Activator Leaderboard')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${periodLabel} • ${rows.length} activator(s)` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
