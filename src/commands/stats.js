import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../db/index.js';
import { getGameDisplayName, getGameByAppId } from '../utils/games.js';
import { requireGuild } from '../utils/guild.js';
import { getGlobalStockStats } from '../services/stock.js';

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

  // Stock
  const stock = getGlobalStockStats();

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📊 Server Statistics')
    .addFields(
      { name: '✅ Total activations', value: `**${total}**`, inline: true },
      { name: '📅 This month', value: `**${thisMonth}**`, inline: true },
      { name: '⏱️ Avg response time', value: avgText, inline: true },
      { name: '👥 Active activators', value: `**${activeActivators}**`, inline: true },
      { name: '📦 Stock', value: `**${stock.totalStock}** slots across **${stock.gamesInStock}/${stock.totalGames}** games`, inline: true },
      { name: '🔄 Pending now', value: `**${pending}**`, inline: true },
    );

  if (topGameLines.length > 0) {
    embed.addFields({
      name: '🔥 Most requested games',
      value: topGameLines.join('\n'),
      inline: false,
    });
  }

  embed.setFooter({ text: 'Live stats from the activation database' }).setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
