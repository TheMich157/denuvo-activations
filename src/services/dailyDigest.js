import { EmbedBuilder } from 'discord.js';
import { db } from '../db/index.js';
import { loggingConfig } from '../config/logging.js';
import { getGlobalStockStats, getRestockStats } from './stock.js';
import { getGameByAppId, getGameDisplayName } from '../utils/games.js';
import { debug } from '../utils/debug.js';

const log = debug('dailyDigest');

let clientRef = null;
let timerId = null;

/**
 * Start the daily digest scheduler.
 * Posts a summary every 24 hours to the log channel.
 */
export function startDailyDigest(client) {
  clientRef = client;
  if (timerId) clearInterval(timerId);

  // Calculate ms until next midnight UTC
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setUTCHours(24, 0, 0, 0);
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  // Schedule first run at midnight, then every 24h
  timerId = setTimeout(() => {
    postDigest().catch((err) => log('Digest failed:', err?.message));
    timerId = setInterval(() => {
      postDigest().catch((err) => log('Digest failed:', err?.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  log(`Daily digest scheduled, next in ${Math.round(msUntilMidnight / 60000)} min`);
}

export function stopDailyDigest() {
  if (timerId) { clearTimeout(timerId); clearInterval(timerId); timerId = null; }
  clientRef = null;
}

async function postDigest() {
  if (!clientRef || !loggingConfig.logChannelId) return;
  const channel = await clientRef.channels.fetch(loggingConfig.logChannelId).catch(() => null);
  if (!channel?.send) return;

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Activations today
  const completedRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND completed_at >= ?`
  ).get(yesterday);
  const completed = completedRow?.n ?? 0;

  // Requests created today
  const createdRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE created_at >= ?`
  ).get(yesterday);
  const created = createdRow?.n ?? 0;

  // Failed/cancelled
  const failedRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE status IN ('failed', 'cancelled') AND created_at >= ?`
  ).get(yesterday);
  const failed = failedRow?.n ?? 0;

  // Top activators today
  const topActivators = db.prepare(`
    SELECT issuer_id, COUNT(*) AS cnt FROM requests
    WHERE status = 'completed' AND completed_at >= ?
    GROUP BY issuer_id ORDER BY cnt DESC LIMIT 3
  `).all(yesterday);

  // Top games today
  const topGames = db.prepare(`
    SELECT game_app_id, game_name, COUNT(*) AS cnt FROM requests
    WHERE created_at >= ? GROUP BY game_app_id ORDER BY cnt DESC LIMIT 5
  `).all(yesterday);

  
  // Avg response time today
  const avgRow = db.prepare(`
    SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60) AS avg_mins
    FROM requests WHERE status = 'completed' AND completed_at >= ?
  `).get(yesterday);
  const avgMins = avgRow?.avg_mins != null ? Math.round(avgRow.avg_mins) : null;
  const avgText = avgMins != null
    ? (avgMins < 60 ? `${avgMins}m` : `${Math.floor(avgMins / 60)}h ${avgMins % 60}m`)
    : '—';

  const stock = getGlobalStockStats();

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('📊 Daily Digest')
    .setDescription('Summary of the last 24 hours.')
    .addFields(
      { name: '✅ Completed', value: `**${completed}**`, inline: true },
      { name: '📥 Requests', value: `**${created}**`, inline: true },
      { name: '❌ Failed/Cancelled', value: `**${failed}**`, inline: true },
      { name: '⏱️ Avg response', value: avgText, inline: true },
      { name: '📦 Stock', value: `**${stock.totalStock}** slots`, inline: true },
    );

  if (topActivators.length > 0) {
    const lines = topActivators.map((a, i) => `**${i + 1}.** <@${a.issuer_id}> — ${a.cnt}`);
    embed.addFields({ name: '🏆 Top activators', value: lines.join('\n'), inline: false });
  }

  if (topGames.length > 0) {
    const lines = topGames.map((g, i) => {
      const game = getGameByAppId(g.game_app_id);
      const name = game ? getGameDisplayName(game) : g.game_name;
      return `**${i + 1}.** ${name} — ${g.cnt}`;
    });
    embed.addFields({ name: '🎮 Most requested', value: lines.join('\n'), inline: false });
  }

  embed.setFooter({ text: 'Auto-generated daily digest' }).setTimestamp();

  try {
    await channel.send({ embeds: [embed] });
    log('Daily digest posted');
  } catch (err) {
    log('Failed to post digest:', err?.message);
  }
}
