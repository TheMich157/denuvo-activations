import { db, scheduleSave } from '../db/index.js';
import { isValidDiscordId } from '../utils/validate.js';
import { EmbedBuilder } from 'discord.js';

/* ──────────────── Preorder CRUD ──────────────── */

/**
 * Create a new preorder.
 */
export function createPreorder(gameName, gameAppId, description, price, createdBy, maxSpots = 0, threadId = null) {
  db.prepare(`
    INSERT INTO preorders (game_name, game_app_id, description, price, max_spots, created_by, thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(gameName, gameAppId || null, description || null, price, maxSpots, createdBy, threadId);
  scheduleSave();
  const row = db.prepare('SELECT last_insert_rowid() AS id').get();
  return row?.id;
}

export function setPreorderThread(preorderId, threadId) {
  db.prepare('UPDATE preorders SET thread_id = ? WHERE id = ?').run(threadId, preorderId);
  scheduleSave();
}

export function getPreorder(preorderId) {
  return db.prepare('SELECT * FROM preorders WHERE id = ?').get(preorderId);
}

export function getPreorderByThread(threadId) {
  return db.prepare('SELECT * FROM preorders WHERE thread_id = ?').get(threadId);
}

export function getOpenPreorders() {
  return db.prepare(`SELECT * FROM preorders WHERE status = 'open' ORDER BY created_at DESC`).all();
}

/**
 * List all preorders (optionally filtered by status).
 */
export function getAllPreorders(status = null) {
  if (status) {
    return db.prepare('SELECT * FROM preorders WHERE status = ? ORDER BY created_at DESC').all(status);
  }
  return db.prepare('SELECT * FROM preorders ORDER BY created_at DESC').all();
}

export function closePreorder(preorderId) {
  db.prepare(`UPDATE preorders SET status = 'closed' WHERE id = ?`).run(preorderId);
  scheduleSave();
}

export function deletePreorder(preorderId) {
  db.prepare('DELETE FROM preorder_claims WHERE preorder_id = ?').run(preorderId);
  db.prepare('DELETE FROM preorders WHERE id = ?').run(preorderId);
  scheduleSave();
}

export function fulfillPreorder(preorderId) {
  db.prepare(`UPDATE preorders SET status = 'fulfilled' WHERE id = ?`).run(preorderId);
  scheduleSave();
}

export function refillPreorder(preorderId, newMaxSpots = null) {
  if (newMaxSpots !== null) {
    db.prepare(`UPDATE preorders SET status = 'open', max_spots = ? WHERE id = ?`).run(newMaxSpots, preorderId);
  } else {
    db.prepare(`UPDATE preorders SET status = 'open' WHERE id = ?`).run(preorderId);
  }
  scheduleSave();
}

/**
 * Update editable fields on a preorder (price, max_spots, description).
 */
export function updatePreorder(preorderId, { price, maxSpots, appId, description } = {}) {
  const sets = [];
  const params = [];
  if (price !== undefined) { sets.push('price = ?'); params.push(price); }
  if (maxSpots !== undefined) { sets.push('max_spots = ?'); params.push(maxSpots); }
  if (appId !== undefined) { sets.push('game_app_id = ?'); params.push(appId); }
  if (description !== undefined) { sets.push('description = ?'); params.push(description); }
  if (sets.length === 0) return false;
  params.push(preorderId);
  db.prepare(`UPDATE preorders SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  scheduleSave();
  return true;
}

/* ──────────────── Claims ──────────────── */

export function submitClaim(preorderId, userId, proofMessageId = null) {
  if (!isValidDiscordId(userId)) return false;
  try {
    db.prepare(`
      INSERT OR IGNORE INTO preorder_claims (preorder_id, user_id, proof_message_id)
      VALUES (?, ?, ?)
    `).run(preorderId, userId, proofMessageId);
    scheduleSave();
    return true;
  } catch {
    return false;
  }
}

export function verifyClaim(preorderId, userId) {
  db.prepare(`
    UPDATE preorder_claims SET verified = 1, verified_at = datetime('now')
    WHERE preorder_id = ? AND user_id = ?
  `).run(preorderId, userId);
  scheduleSave();
}

export function isClaimVerified(preorderId, userId) {
  const row = db.prepare(
    'SELECT verified FROM preorder_claims WHERE preorder_id = ? AND user_id = ?'
  ).get(preorderId, userId);
  return row?.verified === 1;
}

export function getClaimsForPreorder(preorderId) {
  return db.prepare(
    'SELECT * FROM preorder_claims WHERE preorder_id = ? ORDER BY created_at ASC'
  ).all(preorderId);
}

export function getClaim(preorderId, userId) {
  return db.prepare(
    'SELECT * FROM preorder_claims WHERE preorder_id = ? AND user_id = ?'
  ).get(preorderId, userId);
}

/**
 * Remove a specific user's claim from a preorder.
 */
export function removeClaim(preorderId, userId) {
  const result = db.prepare(
    'DELETE FROM preorder_claims WHERE preorder_id = ? AND user_id = ?'
  ).run(preorderId, userId);
  scheduleSave();
  return result.changes > 0;
}

export function getPendingClaims() {
  return db.prepare(`
    SELECT pc.*, p.game_name, p.price
    FROM preorder_claims pc
    JOIN preorders p ON p.id = pc.preorder_id
    WHERE pc.verified = 0 AND pc.proof_message_id IS NOT NULL
    ORDER BY pc.created_at ASC
  `).all();
}

/**
 * Get stale unverified claims older than the given number of hours.
 * Only returns claims for open preorders.
 */
export function getStaleUnverifiedClaims(hours = 48) {
  return db.prepare(`
    SELECT pc.*, p.game_name, p.price, p.thread_id
    FROM preorder_claims pc
    JOIN preorders p ON p.id = pc.preorder_id
    WHERE pc.verified = 0
      AND p.status = 'open'
      AND datetime(pc.created_at) < datetime('now', '-' || ? || ' hours')
    ORDER BY pc.created_at ASC
  `).all(hours);
}

/**
 * Remove stale unverified claims and return count removed.
 */
export function removeStaleUnverifiedClaims(hours = 48) {
  const stale = getStaleUnverifiedClaims(hours);
  if (stale.length === 0) return { removed: 0, claims: [] };
  for (const claim of stale) {
    db.prepare('DELETE FROM preorder_claims WHERE id = ?').run(claim.id);
  }
  scheduleSave();
  return { removed: stale.length, claims: stale };
}

/* ──────────────── Spots ──────────────── */

/**
 * Get spots info for a preorder.
 * @returns {{ total: number; claimed: number; verified: number; pending: number; remaining: number; unlimited: boolean }}
 */
export function getPreorderSpots(preorderId) {
  const preorder = getPreorder(preorderId);
  if (!preorder) return null;
  const claims = getClaimsForPreorder(preorderId);
  const verified = claims.filter((c) => c.verified === 1).length;
  const pending = claims.filter((c) => c.verified !== 1).length;
  const maxSpots = preorder.max_spots || 0;
  const unlimited = maxSpots === 0;
  return {
    total: maxSpots,
    claimed: claims.length,
    verified,
    pending,
    remaining: unlimited ? Infinity : Math.max(0, maxSpots - verified),
    unlimited,
  };
}

export function isPreorderFull(preorderId) {
  const spots = getPreorderSpots(preorderId);
  if (!spots || spots.unlimited) return false;
  return spots.verified >= spots.total;
}

/* ──────────────── Embed helper ──────────────── */

/**
 * Build a visual progress bar.
 */
function progressBar(verified, total, length = 10) {
  const filled = Math.round((verified / total) * length);
  const empty = length - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format spots text for display.
 */
export function formatSpotsText(spots) {
  if (!spots) return 'Unknown';
  if (spots.unlimited) {
    return `${spots.claimed} claimed • ${spots.verified} verified`;
  }
  const bar = progressBar(spots.verified, spots.total);
  return `${bar} ${spots.verified}/${spots.total} verified • ${spots.pending} pending • **${spots.remaining}** left`;
}

/**
 * Build a preorder embed that all callers share.
 * @param {{ preorder, preorderId, status?, spotsText? }} params
 */
export function buildPreorderEmbed({ preorder, preorderId, status, spotsText, kofiUrl, tipChannelId }) {
  const st = status || preorder.status;
  const spots = spotsText || formatSpotsText(getPreorderSpots(preorderId));
  const statusEmoji = st === 'open' ? '🟢 Open' : st === 'closed' ? '🔴 Closed' : st === 'fulfilled' ? '✅ Fulfilled' : st;

  return new EmbedBuilder()
    .setColor(st === 'open' ? 0xe91e63 : st === 'closed' ? 0xed4245 : 0x57f287)
    .setTitle(`🛒 Preorder #${preorderId}: ${preorder.game_name}`)
    .setDescription(
      [
        preorder.description || `Preorder for **${preorder.game_name}**`,
        '',
        `**💰 Minimum donation:** $${preorder.price.toFixed(2)}`,
        `**🎟️ Spots:** ${spots}`,
        `**🔗 Donate:** [Ko-fi](${kofiUrl})`,
        '',
        '**How to claim your spot:**',
        `1. Click **"Reserve Spot"** to hold your place`,
        `2. Donate at least **$${preorder.price.toFixed(2)}** on [Ko-fi](${kofiUrl})`,
        `3. Post your receipt screenshot in <#${tipChannelId || 'tip-verify'}> with **#${preorderId}**`,
        '4. Bot auto-verifies your payment and **confirms your spot**',
        '5. Once fulfilled, you\'ll receive your activation!',
        '',
        '> Reserved spots must be verified within 48 hours or they will be released.',
      ].join('\n')
    )
    .addFields(
      { name: '🎮 Game', value: preorder.game_name, inline: true },
      { name: '📋 Status', value: statusEmoji, inline: true },
      { name: '🎟️ Spots', value: spots, inline: true },
      { name: '👤 Created by', value: `<@${preorder.created_by}>`, inline: true },
    )
    .setFooter({ text: `Preorder #${preorderId} • ${spots}` })
    .setTimestamp();
}
