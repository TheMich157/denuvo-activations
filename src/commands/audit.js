import { SlashCommandBuilder, EmbedBuilder, MessageFlags } from 'discord.js';
import { db } from '../db/index.js';
import { getWarningCount } from '../services/warnings.js';
import { getUserTierInfo, TIERS } from '../services/tiers.js';
import { isBlacklisted } from '../services/blacklist.js';
import { isActivator } from '../utils/activator.js';
import { requireGuild } from '../utils/guild.js';
import { getActivatorRating, formatStars } from '../services/ratings.js';
import { getNotes } from '../services/notes.js';
import { getUserAppeals } from '../services/appeals.js';

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
      { name: '☕ Tier', value: tierLabel, inline: true },
      { name: '⚠️ Warnings', value: `**${warns}**/3`, inline: true },
      { name: '⛔ Blacklisted', value: bl ? '**Yes**' : 'No', inline: true },
      { name: '📥 As Buyer', value: `Total: **${buyerStats?.total ?? 0}** • ✅ ${buyerStats?.completed ?? 0} • ❌ ${buyerStats?.cancelled ?? 0} • 💀 ${buyerStats?.failed ?? 0}`, inline: false },
      { name: '📤 As Activator', value: `Completed: **${issuerStats?.completed ?? 0}**/${issuerStats?.total ?? 0}`, inline: true },
      { name: '⭐ Rating', value: ratingText, inline: true },
      { name: '📝 Reviews Given', value: `**${reviewsGiven}**`, inline: true },
      { name: '⚠️ Recent Warnings', value: warnLines, inline: false },
    )
    .setTimestamp();

  
  // Staff notes
  const notes = getNotes(uid);
  if (notes.length > 0) {
    const noteLines = notes.slice(0, 5).map((n) => {
      const date = new Date(n.created_at + 'Z');
      return `**#${n.id}** ${n.note.slice(0, 80)} — <@${n.added_by}> <t:${Math.floor(date.getTime() / 1000)}:R>`;
    }).join('\n');
    embed.addFields({ name: `📝 Staff Notes (${notes.length})`, value: noteLines, inline: false });
  }

  // Appeals
  const appeals = getUserAppeals(uid);
  if (appeals.length > 0) {
    const appealLines = appeals.slice(0, 3).map((a) => {
      const statusEmoji = a.status === 'approved' ? '✅' : a.status === 'denied' ? '❌' : '⏳';
      return `${statusEmoji} **#${a.id}** ${a.status} — ${a.reason.slice(0, 60)}`;
    }).join('\n');
    embed.addFields({ name: `📋 Appeals (${appeals.length})`, value: appealLines, inline: false });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
