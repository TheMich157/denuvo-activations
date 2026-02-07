import { db, scheduleSave } from '../db/index.js';
import { isValidDiscordId } from '../utils/validate.js';

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

/**
 * Set the thread ID for a preorder.
 */
export function setPreorderThread(preorderId, threadId) {
  db.prepare('UPDATE preorders SET thread_id = ? WHERE id = ?').run(threadId, preorderId);
  scheduleSave();
}

/**
 * Get a preorder by ID.
 */
export function getPreorder(preorderId) {
  return db.prepare('SELECT * FROM preorders WHERE id = ?').get(preorderId);
}

/**
 * Get a preorder by thread ID.
 */
export function getPreorderByThread(threadId) {
  return db.prepare('SELECT * FROM preorders WHERE thread_id = ?').get(threadId);
}

/**
 * List open preorders.
 */
export function getOpenPreorders() {
  return db.prepare(`SELECT * FROM preorders WHERE status = 'open' ORDER BY created_at DESC`).all();
}

/**
 * Close a preorder (set status to closed).
 */
export function closePreorder(preorderId) {
  db.prepare(`UPDATE preorders SET status = 'closed' WHERE id = ?`).run(preorderId);
  scheduleSave();
}

/**
 * Fully delete a preorder and all its claims from the DB.
 */
export function deletePreorder(preorderId) {
  db.prepare('DELETE FROM preorder_claims WHERE preorder_id = ?').run(preorderId);
  db.prepare('DELETE FROM preorders WHERE id = ?').run(preorderId);
  scheduleSave();
}

/**
 * Mark a preorder as fulfilled.
 */
export function fulfillPreorder(preorderId) {
  db.prepare(`UPDATE preorders SET status = 'fulfilled' WHERE id = ?`).run(preorderId);
  scheduleSave();
}

/**
 * Refill / reopen a preorder (reset to open, optionally update max_spots).
 */
export function refillPreorder(preorderId, newMaxSpots = null) {
  if (newMaxSpots !== null) {
    db.prepare(`UPDATE preorders SET status = 'open', max_spots = ? WHERE id = ?`).run(newMaxSpots, preorderId);
  } else {
    db.prepare(`UPDATE preorders SET status = 'open' WHERE id = ?`).run(preorderId);
  }
  scheduleSave();
}

/**
 * Submit a claim for a preorder (user wants to donate).
 */
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

/**
 * Verify a user's claim on a preorder.
 */
export function verifyClaim(preorderId, userId) {
  db.prepare(`
    UPDATE preorder_claims SET verified = 1, verified_at = datetime('now')
    WHERE preorder_id = ? AND user_id = ?
  `).run(preorderId, userId);
  scheduleSave();
}

/**
 * Check if a user has a verified claim on a preorder.
 */
export function isClaimVerified(preorderId, userId) {
  const row = db.prepare(
    'SELECT verified FROM preorder_claims WHERE preorder_id = ? AND user_id = ?'
  ).get(preorderId, userId);
  return row?.verified === 1;
}

/**
 * Get all claims for a preorder.
 */
export function getClaimsForPreorder(preorderId) {
  return db.prepare(
    'SELECT * FROM preorder_claims WHERE preorder_id = ? ORDER BY created_at ASC'
  ).all(preorderId);
}

/**
 * Get a claim by user for a specific preorder.
 */
export function getClaim(preorderId, userId) {
  return db.prepare(
    'SELECT * FROM preorder_claims WHERE preorder_id = ? AND user_id = ?'
  ).get(preorderId, userId);
}

/**
 * Get pending (unverified) claims that have proof.
 */
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
 * Get spots info for a preorder.
 * @returns {{ total: number; claimed: number; verified: number; remaining: number; unlimited: boolean }}
 */
export function getPreorderSpots(preorderId) {
  const preorder = getPreorder(preorderId);
  if (!preorder) return null;
  const claims = getClaimsForPreorder(preorderId);
  const verified = claims.filter((c) => c.verified === 1).length;
  const maxSpots = preorder.max_spots || 0;
  const unlimited = maxSpots === 0;
  return {
    total: maxSpots,
    claimed: claims.length,
    verified,
    remaining: unlimited ? Infinity : Math.max(0, maxSpots - verified),
    unlimited,
  };
}

/**
 * Check if a preorder is full (all spots verified). Returns true if full.
 */
export function isPreorderFull(preorderId) {
  const spots = getPreorderSpots(preorderId);
  if (!spots || spots.unlimited) return false;
  return spots.verified >= spots.total;
}
