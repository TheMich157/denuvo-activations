import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../db/index.js';
import { getGameDisplayName, getGameByAppId, loadGames } from '../utils/games.js';
import { requireGuild } from '../utils/guild.js';
import { getGlobalStockStats, getRestockStats } from '../services/stock.js';
import { getActivatorRating, formatStars } from '../services/ratings.js';

export const data = new SlashCommandBuilder()
  .setName('stats')
  .setDescription('Server-wide activation statistics')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  // Total activations
  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE status = 'completed'`
  ).get();
  const total = totalRow?.n ?? 0;

  // This month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const monthRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND completed_at >= ?`
  ).get(monthStart.toISOString());
  const thisMonth = monthRow?.n ?? 0;

  // Today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND completed_at >= ?`
  ).get(todayStart.toISOString());
  const today = todayRow?.n ?? 0;

  // Active activators (with at least 1 game registered)
  const activatorRow = db.prepare(
    `SELECT COUNT(DISTINCT activator_id) AS n FROM activator_games`
  ).get();
  const activeActivators = activatorRow?.n ?? 0;

  // Most requested games (top 5)
  const topGames = db.prepare(`
    SELECT game_app_id, game_name, COUNT(*) AS cnt
    FROM requests
    GROUP BY game_app_id
    ORDER BY cnt DESC
    LIMIT 5
  `).all();

  const topGameLines = topGames.map((g, i) => {
    const game = getGameByAppId(g.game_app_id);
    const name = game ? getGameDisplayName(game) : g.game_name;
    return `**${i + 1}.** ${name} — **${g.cnt}** request${g.cnt !== 1 ? 's' : ''}`;
  });

  // Average response time (created → completed, in minutes)
  const avgRow = db.prepare(`
    SELECT AVG(
      (julianday(completed_at) - julianday(created_at)) * 24 * 60
    ) AS avg_mins
    FROM requests
    WHERE status = 'completed' AND completed_at IS NOT NULL
  `).get();
  const avgMins = avgRow?.avg_mins != null ? Math.round(avgRow.avg_mins) : null;
  const avgText = avgMins != null
    ? (avgMins < 60 ? `${avgMins} min` : `${Math.floor(avgMins / 60)}h ${avgMins % 60}m`)
    : '—';

  // Pending right now
  const pendingRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE status IN ('pending', 'in_progress')`
  ).get();
  const pending = pendingRow?.n ?? 0;

  // Completion rate
  const totalRequests = db.prepare(`SELECT COUNT(*) AS n FROM requests`).get();
  const totalReq = totalRequests?.n ?? 0;
  const completionRate = totalReq > 0 ? Math.round((total / totalReq) * 100) : 0;

  // Stock & restock
  const stock = getGlobalStockStats();
  const restock = getRestockStats();

  // Busiest hour (hour with most requests)
  const busiestRow = db.prepare(`
    SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hour, COUNT(*) AS cnt
    FROM requests GROUP BY hour ORDER BY cnt DESC LIMIT 1
  `).get();
  const busiestHour = busiestRow ? `${String(busiestRow.hour).padStart(2, '0')}:00 UTC` : '—';

  // Top rated activators
  const topRated = db.prepare(`
    SELECT activator_id, AVG(rating) AS avg, COUNT(*) AS cnt
    FROM activator_ratings
    GROUP BY activator_id HAVING cnt >= 3
    ORDER BY avg DESC LIMIT 3
  `).all();

  // High demand game stats
  const allGames = loadGames();
  const highDemandGames = allGames.filter((g) => g.highDemand);

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📊 Server Statistics')
    .addFields(
      { name: '✅ Total activations', value: `**${total}**`, inline: true },
      { name: '📅 This month', value: `**${thisMonth}**`, inline: true },
      { name: '📆 Today', value: `**${today}**`, inline: true },
      { name: '⏱️ Avg response time', value: avgText, inline: true },
      { name: '🎯 Completion rate', value: `**${completionRate}%**`, inline: true },
      { name: '🔄 Pending now', value: `**${pending}**`, inline: true },
      { name: '👥 Active activators', value: `**${activeActivators}**`, inline: true },
      {
        name: '📦 Stock',
        value: `**${stock.totalStock}** slots • **${stock.gamesInStock}/${stock.totalGames}** games\n🟡 Low: ${stock.lowStockCount} • 🔴 Empty: ${stock.emptyCount}`,
        inline: true,
      },
      {
        name: '⏳ Restocking',
        value: `${restock.in1h} in 1h • ${restock.in24h} in 24h\n${restock.total} total pending`,
        inline: true,
      },
    );

  if (topGameLines.length > 0) {
    embed.addFields({
      name: '🔥 Most requested games',
      value: topGameLines.join('\n'),
      inline: false,
    });
  }

  if (topRated.length > 0) {
    const ratedLines = topRated.map((r, i) => {
      const { average } = getActivatorRating(r.activator_id);
      return `**${i + 1}.** <@${r.activator_id}> — ${formatStars(average)} (${r.cnt} ratings)`;
    });
    embed.addFields({
      name: '⭐ Top rated activators',
      value: ratedLines.join('\n'),
      inline: false,
    });
  }

  if (highDemandGames.length > 0) {
    embed.addFields({
      name: '🔥 High demand games',
      value: `**${highDemandGames.length}** game${highDemandGames.length !== 1 ? 's' : ''} with 48h cooldown`,
      inline: true,
    });
  }

  embed.addFields({
    name: '🕐 Busiest hour',
    value: busiestHour,
    inline: true,
  });

  embed.setFooter({ text: 'Live stats from the activation database' }).setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
