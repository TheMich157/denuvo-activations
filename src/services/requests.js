import { db, scheduleSave } from '../db/index.js';
import { getActivatorsForGame, incrementDailyActivation, getCredentials, decrementActivatorStock } from './activators.js';
import { addPoints } from './points.js';
import { config } from '../config.js';
import { isValidDiscordId, isValidRequestId, isValidAppId } from '../utils/validate.js';
import { getCooldownHours } from '../utils/games.js';
import crypto from 'crypto';

const VALID_FAIL_REASONS = ['failed', 'cancelled', 'invalid_token'];

export function checkCooldown(buyerId, gameAppId) {
  if (!isValidDiscordId(buyerId) || !isValidAppId(gameAppId)) return null;
  const row = db.prepare(
    'SELECT cooldown_until FROM activation_cooldowns WHERE buyer_id = ? AND game_app_id = ?'
  ).get(buyerId, gameAppId);
  if (!row) return null;
  const until = new Date(row.cooldown_until).getTime();
  if (Date.now() >= until) return null;
  return until;
}

/** @returns {{ game_app_id: number; cooldown_until: string }[]} */
export function getCooldownsForUser(buyerId) {
  if (!isValidDiscordId(buyerId)) return [];
  return db.prepare(
    `SELECT game_app_id, cooldown_until FROM activation_cooldowns
     WHERE buyer_id = ? AND datetime(cooldown_until) > datetime('now')
     ORDER BY cooldown_until ASC`
  ).all(buyerId);
}

export function setCooldown(buyerId, gameAppId, hours = null) {
  if (!isValidDiscordId(buyerId) || !isValidAppId(gameAppId)) return;
  const h = hours != null ? hours : getCooldownHours(gameAppId);
  const until = new Date(Date.now() + h * 60 * 60 * 1000).toISOString();
  db.prepare(
    'INSERT OR REPLACE INTO activation_cooldowns (buyer_id, game_app_id, cooldown_until) VALUES (?, ?, ?)'
  ).run(buyerId, gameAppId, until);
  scheduleSave();
}

export function markScreenshotVerified(requestId) {
  if (!isValidRequestId(requestId)) return;
  db.prepare('UPDATE requests SET screenshot_verified = 1 WHERE id = ?').run(requestId);
  scheduleSave();
}

export function createRequest(buyerId, gameAppId, gameName) {
  if (!isValidDiscordId(buyerId)) throw new Error('Invalid buyer ID');
  if (!isValidAppId(gameAppId)) throw new Error('Invalid game ID');
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO requests (id, buyer_id, game_app_id, game_name, status) VALUES (?, ?, ?, ?, 'pending')
  `).run(id, buyerId, gameAppId, gameName);
  scheduleSave();
  return id;
}

export function getRequest(requestId) {
  if (!isValidRequestId(requestId)) return null;
  return db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
}

export function assignIssuer(requestId, issuerId) {
  if (!isValidRequestId(requestId) || !isValidDiscordId(issuerId)) {
    return { ok: false, error: 'Invalid request or user' };
  }
  const req = getRequest(requestId);
  if (!req || req.status !== 'pending') return { ok: false, error: 'Invalid or already claimed request' };

  const activators = getActivatorsForGame(req.game_app_id);
  const canClaim = activators.some((a) => a.activator_id === issuerId);
  if (!canClaim) return { ok: false, error: 'You do not have this game registered or daily limit reached' };

  const points = config.pointsPerActivation;

  const succeeded = db.transaction(() => {
    const current = db.prepare('SELECT status FROM requests WHERE id = ?').get(requestId);
    if (!current || current.status !== 'pending') return false;
    db.prepare(`
      UPDATE requests SET issuer_id = ?, status = 'in_progress', points_charged = ?, updated_at = datetime('now') WHERE id = ?
    `).run(issuerId, points, requestId);
    return true;
  });
  if (succeeded !== true) return { ok: false, error: 'Request was already claimed' };
  scheduleSave();
  return { ok: true };
}

export function completeRequest(requestId, authCode) {
  const req = getRequest(requestId);
  if (!req || req.status !== 'in_progress') return false;
  if (!req.screenshot_verified) return 'screenshot_not_verified';
  const code = typeof authCode === 'string' ? authCode.trim() : String(authCode ?? '').trim();
  if (!code) return false;
  db.prepare(`
    UPDATE requests SET status = 'completed', auth_code = ?, completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?
  `).run(code, requestId);
  addPoints(req.issuer_id, req.points_charged, 'activation_completed', requestId);
  const steamId = getCredentials(req.issuer_id, req.game_app_id)?.username ?? `manual_${req.issuer_id}_${req.game_app_id}`;
  incrementDailyActivation(steamId);
  decrementActivatorStock(req.issuer_id, req.game_app_id);
  setCooldown(req.buyer_id, req.game_app_id);
  scheduleSave();
  return true;
}

export function failRequest(requestId, reason = 'failed') {
  const safeReason = VALID_FAIL_REASONS.includes(reason) ? reason : 'failed';
  const req = getRequest(requestId);
  if (!req || req.status !== 'in_progress') return false;
  db.prepare(`UPDATE requests SET status = ? WHERE id = ?`).run(safeReason, requestId);
  scheduleSave();
  return true;
}

export function getPendingRequestForChannel(channelId) {
  if (!channelId) return null;
  return db.prepare(
    'SELECT * FROM requests WHERE ticket_channel_id = ? AND status IN (\'pending\', \'in_progress\')'
  ).get(channelId);
}

export function getRequestByChannel(channelId) {
  if (!channelId) return null;
  return db.prepare('SELECT * FROM requests WHERE ticket_channel_id = ?').get(channelId);
}

export function cancelRequest(requestId) {
  const req = getRequest(requestId);
  if (!req) return false;
  if (req.status === 'completed' || req.status === 'cancelled' || req.status === 'failed') return false;
  db.prepare(`UPDATE requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(requestId);
  // Refund skip token if one was used and request was never completed
  if (req.used_skip_token) {
    import('./skipTokens.js').then(m => m.addTokens(req.buyer_id, 1)).catch(() => {});
  }
  scheduleSave();
  return true;
}

export function setTicketChannel(requestId, channelId) {
  if (!isValidRequestId(requestId)) return;
  db.prepare('UPDATE requests SET ticket_channel_id = ? WHERE id = ?').run(String(channelId), requestId);
  scheduleSave();
}

export function getUnverifiedPendingOlderThan(maxAgeMinutes) {
  return db.prepare(`
    SELECT id, buyer_id, game_app_id, ticket_channel_id, game_name, status
    FROM requests
    WHERE status IN ('pending', 'in_progress')
      AND (screenshot_verified IS NULL OR screenshot_verified = 0)
      AND COALESCE(no_auto_close, 0) = 0
      AND datetime(created_at) < datetime('now', '-' || ? || ' minutes')
  `).all(maxAgeMinutes);
}

/** Set the no_auto_close flag on a request. */
export function setNoAutoClose(requestId, value = true) {
  db.prepare('UPDATE requests SET no_auto_close = ? WHERE id = ?').run(value ? 1 : 0, requestId);
  scheduleSave();
}

/** Get queue position and count for a user's pending request. */
export function getQueuePosition(requestId) {
  const req = db.prepare('SELECT * FROM requests WHERE id = ?').get(requestId);
  if (!req || req.status !== 'pending') return null;
  const ahead = db.prepare(`
    SELECT COUNT(*) AS n FROM requests
    WHERE status = 'pending' AND game_app_id = ? AND datetime(created_at) < datetime(?)
  `).get(req.game_app_id, req.created_at);
  const total = db.prepare(`
    SELECT COUNT(*) AS n FROM requests WHERE status = 'pending' AND game_app_id = ?
  `).get(req.game_app_id);
  return { position: (ahead?.n ?? 0) + 1, total: total?.n ?? 1, gameName: req.game_name, gameAppId: req.game_app_id };
}

/** Get all pending/in_progress requests for a user. */
export function getUserActiveRequests(userId) {
  return db.prepare(`
    SELECT id, game_app_id, game_name, status, issuer_id, created_at, ticket_channel_id
    FROM requests
    WHERE buyer_id = ? AND status IN ('pending', 'in_progress')
    ORDER BY created_at ASC
  `).all(userId);
}

/** SLA stats: average completion time (minutes) for recent completed requests. */
export function getAvgCompletionMinutes(limit = 50) {
  const rows = db.prepare(`
    SELECT ROUND((julianday(completed_at) - julianday(created_at)) * 1440, 1) AS mins
    FROM requests WHERE status = 'completed' AND completed_at IS NOT NULL
    ORDER BY completed_at DESC LIMIT ?
  `).all(limit);
  if (rows.length === 0) return null;
  const sum = rows.reduce((a, r) => a + (r.mins ?? 0), 0);
  return Math.round(sum / rows.length);
}

/** SLA stats per activator: avg completion time, total completed, avg rating. */
export function getActivatorSLA(activatorId) {
  const completion = db.prepare(`
    SELECT COUNT(*) AS total,
           ROUND(AVG((julianday(completed_at) - julianday(created_at)) * 1440), 1) AS avg_mins,
           MIN(ROUND((julianday(completed_at) - julianday(created_at)) * 1440, 1)) AS best_mins,
           MAX(ROUND((julianday(completed_at) - julianday(created_at)) * 1440, 1)) AS worst_mins
    FROM requests WHERE issuer_id = ? AND status = 'completed' AND completed_at IS NOT NULL
  `).get(activatorId);
  const rating = db.prepare(`
    SELECT AVG(rating) AS avg_rating, COUNT(*) AS total_ratings
    FROM activator_ratings WHERE activator_id = ?
  `).get(activatorId);
  const recent24h = db.prepare(`
    SELECT COUNT(*) AS n FROM requests
    WHERE issuer_id = ? AND status = 'completed' AND datetime(completed_at) > datetime('now', '-24 hours')
  `).get(activatorId);
  return {
    totalCompleted: completion?.total ?? 0,
    avgMinutes: completion?.avg_mins ? Math.round(completion.avg_mins) : null,
    bestMinutes: completion?.best_mins ? Math.round(completion.best_mins) : null,
    worstMinutes: completion?.worst_mins ? Math.round(completion.worst_mins) : null,
    avgRating: rating?.avg_rating ? parseFloat(rating.avg_rating.toFixed(1)) : null,
    totalRatings: rating?.total_ratings ?? 0,
    completedLast24h: recent24h?.n ?? 0,
  };
}

/** Get unclaimed pending requests older than X minutes. */
export function getUnclaimedPendingOlderThan(minutes) {
  return db.prepare(`
    SELECT id, buyer_id, game_app_id, game_name, ticket_channel_id, created_at
    FROM requests
    WHERE status = 'pending' AND issuer_id IS NULL
      AND datetime(created_at) < datetime('now', '-' || ? || ' minutes')
  `).all(minutes);
}

/** All open requests (pending or in_progress) that have a ticket channel. */
export function getOpenTicketRequests() {
  return db.prepare(`
    SELECT id, buyer_id, issuer_id, game_app_id, game_name, ticket_channel_id, status
    FROM requests
    WHERE status IN ('pending', 'in_progress') AND ticket_channel_id IS NOT NULL AND ticket_channel_id != ''
  `).all();
}
