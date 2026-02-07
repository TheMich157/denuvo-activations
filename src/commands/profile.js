import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../db/index.js';
import { getBalance } from '../services/points.js';
import { getActivatorGames, getDailyCount, getPendingRestockCount, getNextRestockAt } from '../services/activators.js';
import { getCooldownsForUser } from '../services/requests.js';
import { isActivator } from '../utils/activator.js';
import { isWhitelisted } from '../utils/whitelist.js';
import { requireGuild } from '../utils/guild.js';
import { formatPointsAsMoney } from '../utils/pointsFormat.js';
import { getGameDisplayName, getGameByAppId, getCooldownHours } from '../utils/games.js';
import { isAway } from '../services/activatorStatus.js';
import { getActivatorRating, formatStars } from '../services/ratings.js';
import { getStreakInfo } from '../services/streaks.js';
import { config } from '../config.js';
import { getUserTierInfo, TIERS } from '../services/tiers.js';
import { getWarningCount } from '../services/warnings.js';

const HISTORY_LIMIT = 5;

export const data = new SlashCommandBuilder()
  .setName('profile')
  .setDescription('View a profile: credits, cooldowns, history, and (for activators) games list')
  .setContexts(0)
  .addUserOption((o) =>
    o
      .setName('user')
      .setDescription('View this user\'s profile (leave empty for your own)')
      .setRequired(false)
  );

/**
 * Determine account type label.
 */
function getAccountLabel(member, userId) {
  const activator = member ? isActivator(member) : false;
  const wl = isWhitelisted(userId);
  if (activator && wl) return '⭐ **Whitelisted Activator**';
  if (activator) return '🛠️ **Activator**';
  return '👤 **User**';
}

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const targetUser = interaction.options.getUser('user') ?? interaction.user;
  const targetMember = targetUser.id === interaction.user.id
    ? interaction.member
    : await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  const userId = targetUser.id;
  const points = getBalance(userId);
  const activator = targetMember ? isActivator(targetMember) : false;
  const games = activator ? getActivatorGames(userId) : [];
  const restockHours = config.restockHours || 24;
  const cooldowns = getCooldownsForUser(userId);
  const away = activator && isAway(userId);

  const embed = new EmbedBuilder()
    .setColor(activator ? 0x57f287 : 0x5865f2)
    .setAuthor({
      name: targetUser.displayName || targetUser.username,
      iconURL: targetUser.displayAvatarURL({ size: 64 }),
    })
    .setTitle('Profile')
    .setTimestamp();

  const viewedBySuffix = targetUser.id !== interaction.user.id
    ? ` • Viewed by ${interaction.user.displayName || interaction.user.username}`
    : '';

  // —— Account type + tier ——
  const accountLabel = getAccountLabel(targetMember, userId);
  const awayTag = away ? ' • 🌙 Away' : '';
  const tierInfo = getUserTierInfo(userId);
  const tierTag = tierInfo.tier !== 'none' ? `\n${TIERS[tierInfo.tier].emoji} **${TIERS[tierInfo.tier].label}**` : '';
  const warns = getWarningCount(userId);
  const warnTag = warns > 0 ? `\n⚠️ Warnings: **${warns}**/3` : '';
  embed.addFields({
    name: '👤 Account',
    value: `${accountLabel}${awayTag}${tierTag}${warnTag}`,
    inline: true,
  });

  // —— Credits ——
  embed.addFields({
    name: '💰 Credits',
    value: `**${points}** pts (${formatPointsAsMoney(points)})`,
    inline: true,
  });

  // —— Quick stats ——
  const completedRow = activator
    ? db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE issuer_id = ? AND status = 'completed'`).get(userId)
    : db.prepare(`SELECT COUNT(*) AS n FROM requests WHERE buyer_id = ?`).get(userId);
  const statCount = completedRow?.n ?? 0;
  embed.addFields({
    name: activator ? '✅ Activations' : '📋 Requests',
    value: `**${statCount}**`,
    inline: true,
  });

  // —— Rating (activators only) ——
  if (activator) {
    const { average, count } = getActivatorRating(userId);
    const ratingText = average != null
      ? `${formatStars(average)} **${average}**/5 (${count} rating${count !== 1 ? 's' : ''})`
      : 'No ratings yet';
    embed.addFields({ name: '⭐ Rating', value: ratingText, inline: true });
  }

  // —— Reviews given (non-activators) ——
  if (!activator) {
    const reviewsGiven = db.prepare(
      `SELECT COUNT(*) AS n FROM activator_ratings WHERE buyer_id = ?`
    ).get(userId);
    const reviewCount = reviewsGiven?.n ?? 0;
    if (reviewCount > 0) {
      embed.addFields({ name: '📝 Reviews Given', value: `**${reviewCount}**`, inline: true });
    }
  }

  // —— Avg response time (activators only) ——
  if (activator) {
    const avgRow = db.prepare(`
      SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60) AS avg_mins
      FROM requests WHERE issuer_id = ? AND status = 'completed' AND completed_at IS NOT NULL
    `).get(userId);
    const avgMins = avgRow?.avg_mins != null ? Math.round(avgRow.avg_mins) : null;
    if (avgMins != null) {
      const avgText = avgMins < 60 ? `**${avgMins}** min` : `**${Math.floor(avgMins / 60)}h ${avgMins % 60}m**`;
      embed.addFields({ name: '⚡ Avg Response', value: avgText, inline: true });
    }
  }

  // —— Streak (activators only) ——
  if (activator) {
    const streak = getStreakInfo(userId);
    const streakText = streak.current > 0
      ? `🔥 **${streak.current}** day${streak.current !== 1 ? 's' : ''} (best: ${streak.longest})`
      : `Best: **${streak.longest}** day${streak.longest !== 1 ? 's' : ''}`;
    embed.addFields({ name: '📆 Streak', value: streakText, inline: true });
  }

  // —— Cooldowns ——
  if (cooldowns.length > 0) {
    const lines = cooldowns.map((c) => {
      const game = getGameByAppId(c.game_app_id);
      const displayName = game ? getGameDisplayName(game) : `App ${c.game_app_id}`;
      const until = new Date(c.cooldown_until).getTime();
      const hrs = getCooldownHours(c.game_app_id);
      return `• **${displayName}** — <t:${Math.floor(until / 1000)}:R> (${hrs}h)`;
    });
    embed.addFields({
      name: '⏱️ Cooldowns',
      value: lines.join('\n'),
      inline: false,
    });
  }

  // —— Activator games ——
  if (activator && games.length > 0) {
    const limit = config.dailyActivationLimit;
    const lines = games.map((g) => {
      const game = getGameByAppId(g.game_app_id);
      const displayName = game ? getGameDisplayName(game) : g.game_name;
      const steamId = g.steam_username || `manual_${userId}_${g.game_app_id}`;
      const today = getDailyCount(steamId);
      const remaining = Math.max(0, limit - today);
      const methodLabel = g.method === 'automated' ? '🤖' : '👤';
      const stock = g.stock_quantity ?? 5;
      const pending = getPendingRestockCount(userId, g.game_app_id);
      const nextAt = getNextRestockAt(userId, g.game_app_id);
      let restockText = '';
      if (pending > 0 && nextAt) {
        const ms = new Date(nextAt).getTime() - Date.now();
        const hrs = Math.max(0, Math.ceil(ms / (60 * 60 * 1000)));
        restockText = ` • +${pending} in ~${hrs}h`;
      } else if (pending > 0) restockText = ` • +${pending} restocking`;
      return `• **${displayName}** ${methodLabel} — stock: **${stock}**${restockText} • **${remaining}/${limit}** today`;
    });
    embed.addFields({
      name: '🎮 Games',
      value: lines.join('\n'),
      inline: false,
    });
  } else if (activator) {
    embed.addFields({
      name: '🎮 Games',
      value: 'No games registered. Use `/add` or `/stock`.',
      inline: false,
    });
  }

  // —— Recent history ——
  const historyColumn = activator ? 'issuer_id' : 'buyer_id';
  const historyRows = db.prepare(`
    SELECT game_app_id, game_name, status, created_at, completed_at, points_charged
    FROM requests
    WHERE ${historyColumn} = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, HISTORY_LIMIT);

  if (historyRows.length > 0) {
    const statusEmoji = { completed: '✅', pending: '⏳', in_progress: '🔄', failed: '❌', cancelled: '🚫' };
    const lines = historyRows.map((r) => {
      const game = getGameByAppId(r.game_app_id);
      const name = game ? getGameDisplayName(game) : r.game_name;
      const emoji = statusEmoji[r.status] ?? '❓';
      const date = r.completed_at || r.created_at;
      const ts = date ? `<t:${Math.floor(new Date(date).getTime() / 1000)}:d>` : '—';
      const pts = r.status === 'completed' && activator ? ` +${r.points_charged}pts` : '';
      return `${emoji} **${name}** ${ts}${pts}`;
    });

    const totalRow = db.prepare(
      `SELECT COUNT(*) AS n FROM requests WHERE ${historyColumn} = ?`
    ).get(userId);
    const totalCount = totalRow?.n ?? historyRows.length;
    const moreText = totalCount > HISTORY_LIMIT ? `\n*… and ${totalCount - HISTORY_LIMIT} more*` : '';

    embed.addFields({
      name: activator ? '📜 Recent activations' : '📜 Recent requests',
      value: lines.join('\n') + moreText,
      inline: false,
    });
  }

  // —— Footer ——
  const footerParts = [];
  if (activator && games.length > 0) {
    footerParts.push(`Restock: ${restockHours}h • ${config.dailyActivationLimit}/day`);
  }
  if (viewedBySuffix) footerParts.push(viewedBySuffix.slice(3));
  if (footerParts.length > 0) {
    embed.setFooter({ text: footerParts.join(' • ') });
  }

  await interaction.reply({ embeds: [embed] });
}
