import { db, scheduleSave } from '../db/index.js';

/**
 * Submit feedback for a completed request.
 */
export function submitFeedback(requestId, userId, rating, comment = null) {
  try {
    db.prepare(`
      INSERT INTO ticket_feedback (request_id, user_id, rating, comment) VALUES (?, ?, ?, ?)
      ON CONFLICT(request_id) DO UPDATE SET rating = ?, comment = ?, created_at = datetime('now')
    `).run(requestId, userId, rating, comment, rating, comment);
    scheduleSave();
    return true;
  } catch { return false; }
}

/**
 * Get feedback for a request.
 */
export function getFeedback(requestId) {
  return db.prepare('SELECT * FROM ticket_feedback WHERE request_id = ?').get(requestId);
}

/**
 * Has user given feedback for a request?
 */
export function hasFeedback(requestId) {
  return !!db.prepare('SELECT 1 FROM ticket_feedback WHERE request_id = ?').get(requestId);
}

/**
 * Get average rating for an activator.
 */
export function getActivatorFeedbackStats(activatorId) {
  const row = db.prepare(`
    SELECT AVG(tf.rating) AS avg, COUNT(*) AS n
    FROM ticket_feedback tf
    JOIN requests r ON r.id = tf.request_id
    WHERE r.issuer_id = ?
  `).get(activatorId);
  return { average: row?.avg ? Math.round(row.avg * 10) / 10 : null, count: row?.n ?? 0 };
}

/**
 * Get all feedback (recent).
 */
export function getRecentFeedback(limit = 10) {
  return db.prepare(`
    SELECT tf.*, r.game_name, r.issuer_id FROM ticket_feedback tf
    JOIN requests r ON r.id = tf.request_id
    ORDER BY tf.created_at DESC LIMIT ?
  `).all(limit);
}
