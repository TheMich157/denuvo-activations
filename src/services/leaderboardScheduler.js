import { EmbedBuilder } from 'discord.js';
import { loggingConfig } from '../config/logging.js';
import { debug } from '../utils/debug.js';

const log = debug('leaderboardScheduler');

let clientRef = null;
let weeklyTimer = null;
let monthlyTimer = null;

// Reward points for top 3 each period
const WEEKLY_REWARDS = [150, 100, 50];
const MONTHLY_REWARDS = [500, 300, 150];

/**
 * Start the weekly and monthly leaderboard schedulers.
 */
export function startLeaderboardScheduler(client) {
  clientRef = client;

  // Schedule weekly reset: every Monday at 00:00 UTC
  scheduleWeekly();
  // Schedule monthly reset: 1st of each month at 00:00 UTC
  scheduleMonthly();

  log('Leaderboard scheduler started');
}

function scheduleWeekly() {
  if (weeklyTimer) clearTimeout(weeklyTimer);
  const now = new Date();
  const next = new Date(now);
  // Find next Monday 00:00 UTC
  const daysUntilMonday = (8 - now.getUTCDay()) % 7 || 7;
  next.setUTCDate(now.getUTCDate() + daysUntilMonday);
  next.setUTCHours(0, 0, 0, 0);
  const ms = next.getTime() - now.getTime();

  weeklyTimer = setTimeout(() => {
    postWeeklySummary().catch((err) => log('Weekly summary failed:', err?.message));
    // Reschedule for next week
    scheduleWeekly();
  }, ms);

  log(`Weekly summary in ${Math.round(ms / 3600000)}h`);
}

function scheduleMonthly() {
  if (monthlyTimer) clearTimeout(monthlyTimer);
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  const ms = next.getTime() - now.getTime();

  monthlyTimer = setTimeout(() => {
    postMonthlySummary().catch((err) => log('Monthly summary failed:', err?.message));
    scheduleMonthly();
  }, ms);

  log(`Monthly summary in ${Math.round(ms / 3600000)}h`);
}

async function postWeeklySummary() {
  if (!clientRef || !loggingConfig.logChannelId) return;
  const channel = await clientRef.channels.fetch(loggingConfig.logChannelId).catch(() => null);
  if (!channel?.send) return;

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(`
    SELECT issuer_id, COUNT(*) AS completions,
           AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60) AS avg_mins
    FROM requests
    WHERE status = 'completed' AND issuer_id IS NOT NULL AND completed_at >= ?
    GROUP BY issuer_id
    ORDER BY completions DESC
    LIMIT 10
  `).all(weekAgo);

  if (rows.length === 0) return;

  // Remove points reward system

  const lines = rows.map((r, i) => {
    const rank = `**${i + 1}.**`;
    const avgMins = r.avg_mins != null ? Math.round(r.avg_mins) : null;
    const avgText = avgMins != null ? ` • ⚡ ${avgMins < 60 ? `${avgMins}m` : `${Math.floor(avgMins / 60)}h`}` : '';
    return `${rank} <@${r.issuer_id}> — **${r.completions}** activations${avgText}`;
  });

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND completed_at >= ?`
  ).get(weekAgo);

  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('🏆 Weekly Leaderboard Reset')
    .setDescription(`**${totalRow?.n ?? 0}** activations completed this week!\n\n${lines.join('\n')}`)
    .addFields({
      name: '📊 Stats',
      value: 'Top performers recognized for their activity!',
      inline: false,
    })
    .setFooter({ text: 'Weekly reset — new week starts now!' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  log('Weekly leaderboard posted');
}

async function postMonthlySummary() {
  if (!clientRef || !loggingConfig.logChannelId) return;
  const channel = await clientRef.channels.fetch(loggingConfig.logChannelId).catch(() => null);
  if (!channel?.send) return;

  const monthStart = new Date();
  monthStart.setUTCMonth(monthStart.getUTCMonth() - 1);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthISO = monthStart.toISOString();

  const monthEnd = new Date();
  monthEnd.setUTCDate(1);
  monthEnd.setUTCHours(0, 0, 0, 0);
  const monthEndISO = monthEnd.toISOString();

  const rows = db.prepare(`
    SELECT issuer_id, COUNT(*) AS completions,
           AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60) AS avg_mins
    FROM requests
    WHERE status = 'completed' AND issuer_id IS NOT NULL
      AND completed_at >= ? AND completed_at < ?
    GROUP BY issuer_id
    ORDER BY completions DESC
    LIMIT 10
  `).all(monthISO, monthEndISO);

  if (rows.length === 0) return;

  // Remove points reward system

  const lines = rows.map((r, i) => {
    const rank = `**${i + 1}.**`;
    const avgMins = r.avg_mins != null ? Math.round(r.avg_mins) : null;
    const avgText = avgMins != null ? ` • ⚡ ${avgMins < 60 ? `${avgMins}m` : `${Math.floor(avgMins / 60)}h`}` : '';
    return `${rank} <@${r.issuer_id}> — **${r.completions}** activations${avgText}`;
  });

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND completed_at >= ? AND completed_at < ?`
  ).get(monthISO, monthEndISO);

  const monthLabel = monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const embed = new EmbedBuilder()
    .setColor(0xe91e63)
    .setTitle(`🏆 Monthly Leaderboard — ${monthLabel}`)
    .setDescription(`**${totalRow?.n ?? 0}** activations completed last month!\n\n${lines.join('\n')}`)
    .addFields({
      name: '📊 Stats',
      value: 'Top performers recognized for their activity!',
      inline: false,
    })
    .setFooter({ text: `${monthLabel} summary — new month starts now!` })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
  log('Monthly leaderboard posted');
}

export function stopLeaderboardScheduler() {
  if (weeklyTimer) { clearTimeout(weeklyTimer); weeklyTimer = null; }
  if (monthlyTimer) { clearTimeout(monthlyTimer); monthlyTimer = null; }
  clientRef = null;
}
