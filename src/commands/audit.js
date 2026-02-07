import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../db/index.js';
import { getBalance } from '../services/points.js';
import { getWarningCount } from '../services/warnings.js';
import { getUserTierInfo, TIERS } from '../services/tiers.js';
import { isBlacklisted } from '../services/blacklist.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { getActivatorRating, formatStars } from '../services/ratings.js';

export const data = new SlashCommandBuilder()
  .setName('audit')
  .setDescription('View full audit trail for a user (Activator only)')
  .setContexts(0)
  .addUserOption((o) => o.setName('user').setDescription('User to audit').setRequired(true));

export async function execute(interaction) {
  const guildErr = requireGuild(interaction);
  if (guildErr) return interaction.reply({ content: guildErr, flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('user');
  const uid = user.id;

  // Points
  const points = getBalance(uid);

  // Tier
  const tierInfo = getUserTierInfo(uid);
  const tierLabel = tierInfo.tier !== 'none' ? `${TIERS[tierInfo.tier].emoji} ${TIERS[tierInfo.tier].label}` : 'None';

  // Warnings
  const warns = getWarningCount(uid);

  // Blacklisted
  const bl = isBlacklisted(uid);

  // Activations as buyer
  const buyerStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM requests WHERE buyer_id = ?
  `).get(uid);

  // Activations as activator
  const issuerStats = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM requests WHERE issuer_id = ?
  `).get(uid);

  // Rating (as activator)
  const rating = getActivatorRating(uid);
  const ratingText = rating.average != null ? `${formatStars(rating.average)} **${rating.average}**/5 (${rating.count})` : '—';

  // Reviews given
  const reviewsGiven = db.prepare('SELECT COUNT(*) AS n FROM activator_ratings WHERE user_id = ?').get(uid)?.n ?? 0;

  // Recent point transactions
  const recentTx = db.prepare(`
    SELECT amount, type, created_at FROM point_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 5
  `).all(uid);
  const txLines = recentTx.length > 0
    ? recentTx.map((t) => {
        const sign = t.amount >= 0 ? '+' : '';
        const date = new Date(t.created_at + 'Z');
        return `\`${sign}${t.amount}\` ${t.type} • <t:${Math.floor(date.getTime() / 1000)}:R>`;
      }).join('\n')
    : '*No transactions*';

  // Recent warnings
  const recentWarns = db.prepare(`
    SELECT reason, issued_by, created_at FROM warnings WHERE user_id = ? ORDER BY created_at DESC LIMIT 3
  `).all(uid);
  const warnLines = recentWarns.length > 0
    ? recentWarns.map((w) => {
        const date = new Date(w.created_at + 'Z');
        return `• ${w.reason} — by <@${w.issued_by}> <t:${Math.floor(date.getTime() / 1000)}:R>`;
      }).join('\n')
    : '*None*';

  const embed = new EmbedBuilder()
    .setColor(bl ? 0xed4245 : 0x3498db)
    .setTitle(`🔍 Audit: ${user.displayName}`)
    .setThumbnail(user.displayAvatarURL({ size: 128 }))
    .addFields(
      { name: '💰 Points', value: `**${points}**`, inline: true },
      { name: '☕ Tier', value: tierLabel, inline: true },
      { name: '⚠️ Warnings', value: `**${warns}**/3`, inline: true },
      { name: '⛔ Blacklisted', value: bl ? '**Yes**' : 'No', inline: true },
      { name: '📥 As Buyer', value: `Total: **${buyerStats?.total ?? 0}** • ✅ ${buyerStats?.completed ?? 0} • ❌ ${buyerStats?.cancelled ?? 0} • 💀 ${buyerStats?.failed ?? 0}`, inline: false },
      { name: '📤 As Activator', value: `Completed: **${issuerStats?.completed ?? 0}**/${issuerStats?.total ?? 0}`, inline: true },
      { name: '⭐ Rating', value: ratingText, inline: true },
      { name: '📝 Reviews Given', value: `**${reviewsGiven}**`, inline: true },
      { name: '💸 Recent Transactions', value: txLines, inline: false },
      { name: '⚠️ Recent Warnings', value: warnLines, inline: false },
    )
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
