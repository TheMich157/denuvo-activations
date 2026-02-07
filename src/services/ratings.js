import { db, scheduleSave } from '../db/index.js';
import { isValidDiscordId } from '../utils/validate.js';

/**
 * Submit a rating for a completed request.
 * @param {string} requestId
 * @param {string} activatorId
 * @param {string} buyerId
 * @param {number} rating 1-5
 * @returns {boolean}
 */
export function submitRating(requestId, activatorId, buyerId, rating) {
  if (!requestId || !isValidDiscordId(activatorId) || !isValidDiscordId(buyerId)) return false;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return false;
  try {
    db.prepare(
      `INSERT OR IGNORE INTO activator_ratings (request_id, activator_id, buyer_id, rating) VALUES (?, ?, ?, ?)`
    ).run(requestId, activatorId, buyerId, rating);
    scheduleSave();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a request has already been rated.
 */
export function hasRated(requestId) {
  if (!requestId) return false;
  const row = db.prepare('SELECT 1 FROM activator_ratings WHERE request_id = ?').get(requestId);
  return !!row;
}

/**
 * Get average rating and count for an activator.
 * @param {string} activatorId
 * @returns {{ average: number|null, count: number }}
 */
export function getActivatorRating(activatorId) {
  if (!isValidDiscordId(activatorId)) return { average: null, count: 0 };
  const row = db.prepare(
    'SELECT AVG(rating) AS avg, COUNT(*) AS cnt FROM activator_ratings WHERE activator_id = ?'
  ).get(activatorId);
  return {
    average: row?.avg != null ? Math.round(row.avg * 10) / 10 : null,
    count: row?.cnt ?? 0,
  };
}

/**
 * Format rating as stars.
 * @param {number} avg
 * @returns {string}
 */
export function formatStars(avg) {
  if (avg == null) return '—';
  const full = Math.floor(avg);
  const half = avg - full >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}
