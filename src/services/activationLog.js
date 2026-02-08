import { EmbedBuilder } from 'discord.js';
import { loggingConfig } from '../config/logging.js';
import { debug } from '../utils/debug.js';
import { db } from '../db/index.js';

const log = debug('activationLog');

let clientRef = null;

export function setClient(client) {
  clientRef = client;
}

async function getLogChannel() {
  if (!clientRef || !loggingConfig.logChannelId) return null;
  try {
    return await clientRef.channels.fetch(loggingConfig.logChannelId).catch(() => null);
  } catch {
    return null;
  }
}


async function sendToLogChannel(embed) {
  const channel = await getLogChannel();
  if (!channel?.send) return;
  try {
    await channel.send({ embeds: [embed] });
  } catch (err) {
    log('Failed to send to log channel:', err?.message);
  }
}

const EMBED_FIELD_MAX = 1024;

function truncateCode(code) {
  if (typeof code !== 'string') return '';
  const s = code.trim();
  if (s.length <= EMBED_FIELD_MAX - 10) return s;
  return s.slice(0, EMBED_FIELD_MAX - 20) + '… (truncated)';
}

/** Get activator performance stats for the audit log. */
function getActivatorStats(issuerId) {
  try {
    // Today's completions
    const today = db.prepare(`
      SELECT COUNT(*) AS n FROM requests
      WHERE issuer_id = ? AND status = 'completed' AND date(completed_at) = date('now')
    `).get(issuerId);

    // Total completions
    const total = db.prepare(`
      SELECT COUNT(*) AS n FROM requests WHERE issuer_id = ? AND status = 'completed'
    `).get(issuerId);

    // Total assigned (completed + failed + cancelled where they were issuer)
    const totalAssigned = db.prepare(`
      SELECT COUNT(*) AS n FROM requests
      WHERE issuer_id = ? AND status IN ('completed', 'failed', 'cancelled')
    `).get(issuerId);

    // Average response time (time from created_at to completed_at, in minutes)
    const avgTime = db.prepare(`
      SELECT AVG((julianday(completed_at) - julianday(created_at)) * 24 * 60) AS avg_min
      FROM requests
      WHERE issuer_id = ? AND status = 'completed' AND completed_at IS NOT NULL
        AND datetime(completed_at) > datetime('now', '-30 days')
    `).get(issuerId);

    const completionRate = totalAssigned?.n > 0
      ? Math.round((total?.n / totalAssigned?.n) * 100)
      : 100;

    const avgMin = avgTime?.avg_min;
    let avgDisplay = 'N/A';
    if (avgMin != null && !isNaN(avgMin)) {
      if (avgMin < 60) avgDisplay = `${Math.round(avgMin)} min`;
      else avgDisplay = `${(avgMin / 60).toFixed(1)} hrs`;
    }

    return {
      today: today?.n ?? 0,
      total: total?.n ?? 0,
      completionRate,
      avgResponseTime: avgDisplay,
    };
  } catch {
    return null;
  }
}

/**
 * Log a completed activation: who activated, when, with whom, game, token, request id.
 * Enriched with activator performance stats.
 * @param {Object} req - Full request row from DB (id, buyer_id, issuer_id, game_name, game_app_id, auth_code, completed_at, ticket_channel_id, created_at)
 */
export async function logActivation(req) {
  if (!req?.id || !req.auth_code) return;
  const completedAt = req.completed_at ? new Date(req.completed_at) : new Date();
  const codeDisplay = truncateCode(req.auth_code);

  // Calculate how long this specific activation took
  let durationDisplay = '';
  if (req.created_at) {
    const created = new Date(req.created_at);
    const diffMs = completedAt.getTime() - created.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 60) durationDisplay = `${diffMin} min`;
    else durationDisplay = `${(diffMin / 60).toFixed(1)} hrs`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Activation completed')
    .setDescription('Game activation completed and auth code delivered.')
    .addFields(
      { name: 'Request ID', value: `\`${req.id}\``, inline: true },
      { name: 'Game', value: `${req.game_name} (\`${req.game_app_id}\`)`, inline: true },
      { name: 'Activator (issuer)', value: `<@${req.issuer_id}> (\`${req.issuer_id}\`)`, inline: false },
      { name: 'Buyer', value: `<@${req.buyer_id}> (\`${req.buyer_id}\`)`, inline: false },
      { name: 'Auth code / token', value: `\`\`\`\n${codeDisplay}\n\`\`\``, inline: false },
      { name: 'Completed at', value: `<t:${Math.floor(completedAt.getTime() / 1000)}:F>`, inline: true },
    );

  if (durationDisplay) {
    embed.addFields({ name: '⏱️ Duration', value: durationDisplay, inline: true });
  }

  // Activator performance stats
  if (req.issuer_id) {
    const stats = getActivatorStats(req.issuer_id);
    if (stats) {
      embed.addFields({
        name: '📊 Activator Stats',
        value: `Today: **${stats.today}** • Total: **${stats.total}** • Rate: **${stats.completionRate}%** • Avg: **${stats.avgResponseTime}**`,
        inline: false,
      });
    }
  }

  embed.setFooter({ text: `Ticket #${req.id.slice(0, 8).toUpperCase()}` });
  embed.setTimestamp(completedAt);
  await sendToLogChannel(embed);
}

/**
 * Log a ticket auto-closed (unverified pending timeout).
 */
export async function logTicketAutoClosed(data) {
  const { requestId, buyerId, gameName, gameAppId } = data;
  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle('⏱️ Ticket auto-closed')
    .setDescription('Ticket closed: screenshot not verified within deadline.')
    .addFields(
      { name: 'Request ID', value: `\`${requestId}\``, inline: true },
      { name: 'Game', value: `${gameName} (\`${gameAppId}\`)`, inline: true },
      { name: 'Buyer', value: `<@${buyerId}> (\`${buyerId}\`)`, inline: false }
    )
    .setFooter({ text: `Ticket #${(requestId || '').slice(0, 8).toUpperCase()}` })
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a failed/invalid request (invalid token, cancelled, or generic failure).
 */
export async function logRequestFailed(req, reason = 'failed') {
  if (!req?.id) return;
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('❌ Request failed')
    .setDescription(`Request marked as failed: **${reason}**.`)
    .addFields(
      { name: 'Request ID', value: `\`${req.id}\``, inline: true },
      { name: 'Game', value: `${req.game_name} (\`${req.game_app_id}\`)`, inline: true },
      { name: 'Activator (issuer)', value: req.issuer_id ? `<@${req.issuer_id}> (\`${req.issuer_id}\`)` : '—', inline: false },
      { name: 'Buyer', value: `<@${req.buyer_id}> (\`${req.buyer_id}\`)`, inline: false }
    )
    .setFooter({ text: `Ticket #${req.id.slice(0, 8).toUpperCase()}` })
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a restock event (manual add via /stock or /add, or automatic restock).
 * @param {Object} opts
 * @param {string} opts.activatorId - Discord user ID of the activator
 * @param {number} opts.gameAppId
 * @param {string} opts.gameName
 * @param {number} opts.quantity - Number of slots added
 * @param {'manual' | 'automatic'} opts.method
 */
export async function logRestock({ activatorId, gameAppId, gameName, quantity, method }) {
  if (!activatorId || !gameAppId || quantity === 0) return;
  const isAuto = method === 'automatic';
  const isRemoval = quantity < 0;
  const absQty = Math.abs(quantity);
  const title = isRemoval ? '📤 Stock removed' : isAuto ? '🔄 Automatic restock' : '📦 Manual restock';
  const color = isRemoval ? 0xe74c3c : isAuto ? 0x3498db : 0x9b59b6;
  const desc = isRemoval
    ? `**${absQty}** slot(s) removed manually.`
    : isAuto
      ? `**${absQty}** slot(s) restocked automatically (after cooldown).`
      : `**${absQty}** slot(s) added manually.`;
  const methodLabel = isRemoval ? 'Manual (/removestock)' : isAuto ? 'Automatic (scheduled)' : 'Manual (/stock or /add)';
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(desc)
    .addFields(
      { name: 'Game', value: `${gameName || '—'} (\`${gameAppId}\`)`, inline: true },
      { name: 'Quantity', value: `${isRemoval ? '-' : '+'}${absQty}`, inline: true },
      { name: 'Activator', value: `<@${activatorId}> (\`${activatorId}\`)`, inline: false },
      { name: 'Method', value: methodLabel, inline: true }
    )
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a stale in_progress ticket auto-closed due to inactivity.
 */
export async function logStaleTicketClosed({ requestId, buyerId, issuerId, gameName, gameAppId, idleMinutes }) {
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('💤 Stale ticket auto-closed')
    .setDescription(`Ticket closed: no activity for **${idleMinutes}** minutes.`)
    .addFields(
      { name: 'Request ID', value: `\`${requestId}\``, inline: true },
      { name: 'Game', value: `${gameName} (\`${gameAppId}\`)`, inline: true },
      { name: 'Buyer', value: `<@${buyerId}>`, inline: true },
      { name: 'Activator', value: issuerId ? `<@${issuerId}>` : '—', inline: true }
    )
    .setFooter({ text: `Ticket #${(requestId || '').slice(0, 8).toUpperCase()}` })
    .setTimestamp();
  await sendToLogChannel(embed);
}

/* ──────────────── Preorder Logging ──────────────── */

/**
 * Log a preorder creation.
 */
export async function logPreorderCreated({ preorderId, gameName, price, maxSpots, createdBy, threadId }) {
  const spotsText = maxSpots > 0 ? `${maxSpots} spots` : 'Unlimited spots';
  const embed = new EmbedBuilder()
    .setColor(0xe91e63)
    .setTitle('🛒 Preorder created')
    .setDescription(`A new preorder has been created.`)
    .addFields(
      { name: 'Preorder', value: `#${preorderId}`, inline: true },
      { name: 'Game', value: gameName, inline: true },
      { name: 'Price', value: `$${price.toFixed(2)}`, inline: true },
      { name: 'Spots', value: spotsText, inline: true },
      { name: 'Created by', value: `<@${createdBy}>`, inline: true },
      { name: 'Forum post', value: threadId ? `<#${threadId}>` : '—', inline: true },
    )
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a preorder spot claim.
 */
export async function logPreorderClaim({ preorderId, gameName, userId, spotsInfo }) {
  const spotsText = spotsInfo?.unlimited
    ? `${spotsInfo.claimed} claimed`
    : `${spotsInfo.verified}/${spotsInfo.total} verified • ${spotsInfo.remaining} remaining`;
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🎟️ Preorder spot claimed')
    .addFields(
      { name: 'Preorder', value: `#${preorderId} — ${gameName}`, inline: true },
      { name: 'User', value: `<@${userId}>`, inline: true },
      { name: 'Spots', value: spotsText, inline: true },
    )
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a tip verification (auto or manual).
 */
export async function logPreorderVerify({ preorderId, gameName, userId, amount, method, verifiedBy }) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('✅ Tip verified')
    .addFields(
      { name: 'Preorder', value: `#${preorderId} — ${gameName}`, inline: true },
      { name: 'User', value: `<@${userId}>`, inline: true },
      { name: 'Amount', value: amount ? `$${amount.toFixed(2)}` : '—', inline: true },
      { name: 'Method', value: method === 'auto' ? 'Auto-verified (OCR)' : `Manual — by <@${verifiedBy}>`, inline: false },
    )
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a tip rejection.
 */
export async function logPreorderReject({ preorderId, gameName, userId, rejectedBy }) {
  const embed = new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle('❌ Tip rejected')
    .addFields(
      { name: 'Preorder', value: `#${preorderId} — ${gameName}`, inline: true },
      { name: 'User', value: `<@${userId}>`, inline: true },
      { name: 'Rejected by', value: `<@${rejectedBy}>`, inline: true },
    )
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a preorder status change (close, fulfill, refill).
 */
export async function logPreorderStatus({ preorderId, gameName, action, actor, spotsInfo }) {
  const colors = { closed: 0xe67e22, fulfilled: 0x57f287, refilled: 0x9b59b6 };
  const titles = { closed: '🔒 Preorder closed', fulfilled: '🎉 Preorder fulfilled', refilled: '🔄 Preorder refilled' };
  const spotsText = spotsInfo
    ? (spotsInfo.unlimited ? `${spotsInfo.verified} verified` : `${spotsInfo.verified}/${spotsInfo.total} verified`)
    : '—';
  const embed = new EmbedBuilder()
    .setColor(colors[action] ?? 0x5865f2)
    .setTitle(titles[action] ?? `Preorder ${action}`)
    .addFields(
      { name: 'Preorder', value: `#${preorderId} — ${gameName}`, inline: true },
      { name: 'Action', value: action, inline: true },
      { name: 'By', value: `<@${actor}>`, inline: true },
      { name: 'Spots', value: spotsText, inline: true },
    )
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log ticket feedback (DM survey response).
 * @param {Object} opts
 * @param {string} opts.requestId
 * @param {string} opts.userId - The buyer who left feedback
 * @param {number} opts.rating - 1–5 stars
 * @param {string} opts.gameName
 * @param {string|null} opts.issuerId - The activator who handled the ticket
 */
export async function logFeedback({ requestId, userId, rating, gameName, issuerId }) {
  const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
  const color = rating >= 4 ? 0x57f287 : rating >= 2 ? 0xfee75c : 0xed4245;
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle('📝 Ticket Feedback Received')
    .setDescription(`${stars}  **(${rating}/5)**`)
    .addFields(
      { name: 'Ticket', value: `\`#${(requestId || '').slice(0, 8).toUpperCase()}\``, inline: true },
      { name: 'Game', value: gameName || '—', inline: true },
      { name: 'Rating', value: `**${rating}**/5`, inline: true },
      { name: 'From', value: `<@${userId}>`, inline: true },
      { name: 'Activator', value: issuerId ? `<@${issuerId}>` : '—', inline: true },
    )
    .setFooter({ text: `Feedback • Ticket #${(requestId || '').slice(0, 8).toUpperCase()}` })
    .setTimestamp();
  await sendToLogChannel(embed);
}

/**
 * Log a batch of automatic restocks (one embed per run).
 * @param {{ activatorId: string; gameAppId: number; gameName: string }[]} entries
 */
export async function logRestockBatch(entries) {
  if (!entries?.length) return;
  const lines = entries.slice(0, 25).map((e) =>
    `• **${e.gameName || e.gameAppId}** — <@${e.activatorId}>`
  );
  const more = entries.length > 25 ? `\n*…and ${entries.length - 25} more*` : '';
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('🔄 Automatic restock run')
    .setDescription(`**${entries.length}** slot(s) restocked.`)
    .addFields({ name: 'Details', value: lines.join('\n') + more, inline: false })
    .setTimestamp();
  await sendToLogChannel(embed);
}
