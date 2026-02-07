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
        { name: 'This week', value: 'week' },
        { name: 'This month', value: 'month' },
        { name: 'All time', value: 'all' }
      )
  );

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const period = interaction.options.getString('period') ?? 'all';
  const isMonth = period === 'month';
  const isWeek = period === 'week';

  let sinceISO = null;
  if (isMonth) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    sinceISO = monthStart.toISOString();
  } else if (isWeek) {
    sinceISO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  }

  const rows = sinceISO
    ? db.prepare(`
        SELECT r.issuer_id,
               COUNT(*) AS completions,
               COALESCE(SUM(r.points_charged), 0) AS points_earned,
               AVG((julianday(r.completed_at) - julianday(r.created_at)) * 24 * 60) AS avg_mins
        FROM requests r
        WHERE r.status = 'completed' AND r.issuer_id IS NOT NULL AND r.completed_at >= ?
        GROUP BY r.issuer_id
        ORDER BY completions DESC, points_earned DESC
        LIMIT 15
      `).all(sinceISO)
    : db.prepare(`
        SELECT r.issuer_id,
               COUNT(*) AS completions,
               COALESCE(SUM(r.points_charged), 0) AS points_earned,
               AVG((julianday(r.completed_at) - julianday(r.created_at)) * 24 * 60) AS avg_mins
        FROM requests r
        WHERE r.status = 'completed' AND r.issuer_id IS NOT NULL
        GROUP BY r.issuer_id
        ORDER BY completions DESC, points_earned DESC
        LIMIT 15
      `).all();

  if (rows.length === 0) {
    const msg = isWeek ? 'No completions this week yet.' : isMonth ? 'No completions this month yet.' : 'No completions recorded yet.';
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }

  const medals = ['🥇', '🥈', '🥉'];
  const lines = rows.map((r, i) => {
    const rank = medals[i] ?? `**${i + 1}.**`;
    const avgMins = r.avg_mins != null ? Math.round(r.avg_mins) : null;
    const avgText = avgMins != null
      ? ` • ⚡ ${avgMins < 60 ? `${avgMins}m` : `${Math.floor(avgMins / 60)}h${avgMins % 60 > 0 ? ` ${avgMins % 60}m` : ''}`}`
      : '';
    return `${rank} <@${r.issuer_id}> — **${r.completions}** activation${r.completions !== 1 ? 's' : ''} • **${r.points_earned}** pts${avgText}`;
  });

  const periodLabel = isWeek ? 'This week' : isMonth ? 'This month' : 'All time';

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 Activator Leaderboard')
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${periodLabel} • ${rows.length} activator(s)` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
