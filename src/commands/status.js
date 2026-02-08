import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { db } from '../db/index.js';
import { getActivatorSLA, getAvgCompletionMinutes } from '../services/requests.js';
import { getActivatorGames } from '../services/activators.js';
import { config } from '../config.js';
export const data = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Health dashboard — account status, SLA, and system stats (Activator only)')
  .setContexts(0);

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });
  if (!isActivator(interaction.member)) {
    return interaction.reply({ content: 'Only activators can use this command.', flags: MessageFlags.Ephemeral });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const userId = interaction.user.id;
  const games = getActivatorGames(userId);
  const sla = getActivatorSLA(userId);
  const globalAvg = getAvgCompletionMinutes() || 0;

  // System-wide stats
  const pendingCount = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'").get()?.n ?? 0;
  const inProgressCount = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'in_progress'").get()?.n ?? 0;
  const completedToday = db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status = 'completed' AND datetime(completed_at) > datetime('now', '-24 hours')").get()?.n ?? 0;

  // Account health
  const automated = games.filter((g) => g.method === 'automated');
  const manual = games.filter((g) => g.method === 'manual');
  const lowStock = games.filter((g) => (g.stock_quantity ?? 0) <= 2 && (g.stock_quantity ?? 0) > 0);
  const outOfStock = games.filter((g) => (g.stock_quantity ?? 0) === 0);

  // Daily activation usage
  const today = new Date().toISOString().slice(0, 10);
  const limit = config.dailyActivationLimit;
  let totalUsed = 0;
  const accountLines = [];
  for (const g of automated) {
    const steamId = g.steam_username || `manual_${userId}_${g.game_app_id}`;
    const countRow = db.prepare('SELECT count FROM daily_activations WHERE steam_account_id = ? AND date = ?').get(steamId, today);
    const used = countRow?.count ?? 0;
    totalUsed += used;
    const status = used >= limit ? '🔴' : used >= limit * 0.7 ? '🟡' : '🟢';
    accountLines.push(`${status} **${g.steam_username || 'manual'}** — ${g.game_name} (${used}/${limit} today, stock: ${g.stock_quantity ?? 0})`);
  }

  // SLA section
  const slaLines = [];
  if (sla.totalCompleted > 0) {
    slaLines.push(`📊 **Your Stats:**`);
    slaLines.push(`\u2003Total completed: **${sla.totalCompleted}** (${sla.completedLast24h} today)`);
    if (sla.avgMinutes != null) slaLines.push(`\u2003Avg completion: **${sla.avgMinutes} min** (best: ${sla.bestMinutes} min)`);
    if (sla.avgRating != null) slaLines.push(`\u2003Avg rating: **${'⭐'.repeat(Math.round(sla.avgRating))}** ${sla.avgRating}/5 (${sla.totalRatings} reviews)`);
  } else {
    slaLines.push('📊 No completed activations yet.');
  }

  // System section
  const systemLines = [
    `🎫 Pending: **${pendingCount}** | In progress: **${inProgressCount}** | Completed today: **${completedToday}**`,
  ];
  if (globalAvg > 0) systemLines.push(`⏱️ Global avg completion: **${globalAvg} min**`);

  // Warnings
  const warnings = [];
  if (outOfStock.length > 0) warnings.push(`🔴 **${outOfStock.length}** game${outOfStock.length > 1 ? 's' : ''} out of stock`);
  if (lowStock.length > 0) warnings.push(`🟡 **${lowStock.length}** game${lowStock.length > 1 ? 's' : ''} low stock (≤2)`);

  const embed = new EmbedBuilder()
    .setColor(warnings.length > 0 ? 0xfee75c : 0x57f287)
    .setTitle('📡 Activator Dashboard')
    .setDescription([
      `**Games:** ${games.length} total (${automated.length} automated, ${manual.length} manual)`,
      '',
      ...systemLines,
      '',
      ...slaLines,
    ].join('\n'));

  if (accountLines.length > 0) {
    embed.addFields({
      name: `⚡ Automated Accounts (${automated.length})`,
      value: accountLines.slice(0, 15).join('\n') + (accountLines.length > 15 ? `\n… and ${accountLines.length - 15} more` : ''),
      inline: false,
    });
  }

  if (warnings.length > 0) {
    embed.addFields({
      name: '⚠️ Warnings',
      value: warnings.join('\n'),
      inline: false,
    });
  }

  if (lowStock.length > 0) {
    embed.addFields({
      name: '📉 Low Stock Games',
      value: lowStock.map((g) => `\u2003**${g.game_name}** — ${g.stock_quantity} left`).slice(0, 10).join('\n'),
      inline: false,
    });
  }

  embed.setFooter({ text: `Daily limit: ${limit}/account • Restock: ${config.restockHours}h` }).setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}
