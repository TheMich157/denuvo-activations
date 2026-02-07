import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../db/index.js';
import { requireGuild } from '../utils/guild.js';

export const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('View server-wide activation statistics')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const now = new Date();
  const weekAgo = new Date(now - 7 * 86400000).toISOString();
  const monthAgo = new Date(now - 30 * 86400000).toISOString();
  const today = now.toISOString().slice(0, 10);

  // Total activations
  const totalAll = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'completed'`).get()?.n ?? 0;
  const totalWeek = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND completed_at >= ?`).get(weekAgo)?.n ?? 0;
  const totalMonth = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND completed_at >= ?`).get(monthAgo)?.n ?? 0;
  const totalToday = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND completed_at >= ?`).get(today)?.n ?? 0;

  // Pending requests
  const pending = db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE status IN ('pending', 'in_progress')`).get()?.n ?? 0;

  // Most requested games (this month)
  const topGames = db.prepare(`
    SELECT game_name, COUNT(*) AS n FROM requests
    WHERE created_at >= ? GROUP BY game_name ORDER BY n DESC LIMIT 5
  `).all(monthAgo);

  // Average completion time (minutes)
  const avgTime = db.prepare(`
    SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60) AS avg_mins
    FROM requests WHERE status = 'completed' AND completed_at IS NOT NULL AND created_at >= ?
  `).get(monthAgo);
  const avgMins = avgTime?.avg_mins;

  // Top activators this month
  const topActivators = db.prepare(`
    SELECT issuer_id, COUNT(*) AS n FROM requests
    WHERE status = 'completed' AND completed_at >= ?
    GROUP BY issuer_id ORDER BY n DESC LIMIT 5
  `).all(monthAgo);

  // Unique users served
  const uniqueUsers = db.prepare(`SELECT COUNT(DISTINCT buyer_id) AS n FROM requests WHERE status = 'completed'`).get()?.n ?? 0;

  const topGamesText = topGames.length > 0
    ? topGames.map((g, i) => `${i + 1}. **${g.game_name}** — ${g.n}`).join('\n')
    : '*No data*';

  const topActText = topActivators.length > 0
    ? topActivators.map((a, i) => `${i + 1}. <@${a.issuer_id}> — ${a.n}`).join('\n')
    : '*No data*';

  const avgTimeText = avgMins != null
    ? (avgMins >= 60 ? `${Math.floor(avgMins / 60)}h ${Math.round(avgMins % 60)}m` : `${Math.round(avgMins)}m`)
    : '—';

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📊 Activation Statistics')
    .addFields(
      { name: '✅ Completed', value: `Today: **${totalToday}**\nThis week: **${totalWeek}**\nThis month: **${totalMonth}**\nAll time: **${totalAll}**`, inline: true },
      { name: '⏳ Pending', value: `**${pending}**`, inline: true },
      { name: '⚡ Avg Response', value: avgTimeText, inline: true },
      { name: '👥 Unique Users', value: `**${uniqueUsers}**`, inline: true },
      { name: '🎮 Top Games (30d)', value: topGamesText, inline: false },
      { name: '🏆 Top Activators (30d)', value: topActText, inline: false },
    )
    .setFooter({ text: 'Stats based on the last 30 days unless noted' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
