import { db, scheduleSave } from '../db/index.js';
import { getActivatorsForGame, incrementDailyActivation, getCredentials, decrementActivatorStock } from './activators.js';
import { addPoints } from './points.js';
import { config } from '../config.js';
import { isValidDiscordId, isValidRequestId, isValidAppId } from '../utils/validate.js';
import crypto from 'crypto';

const VALID_FAIL_REASONS = ['failed', 'cancelled', 'invalid_token'];
const COOLDOWN_HOURS = 24;

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

export function setCooldown(buyerId, gameAppId, hours = COOLDOWN_HOURS) {
  if (!isValidDiscordId(buyerId) || !isValidAppId(gameAppId)) return;
  const until = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
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
      UPDATE requests SET issuer_id = ?, status = 'in_progress', points_charged = ? WHERE id = ?
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
  db.prepare(`
    UPDATE requests SET status = 'completed', auth_code = ?, completed_at = datetime('now') WHERE id = ?
  `).run(authCode, requestId);
  addPoints(req.issuer_id, req.points_charged, 'activation_completed', requestId);
  const steamId = getCredentials(req.issuer_id, req.game_app_id)?.username ?? `manual_${req.issuer_id}_${req.game_app_id}`;
  incrementDailyActivation(steamId);
  decrementActivatorStock(req.issuer_id, req.game_app_id);
  setCooldown(req.buyer_id, req.game_app_id, COOLDOWN_HOURS);
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
  db.prepare('UPDATE requests SET status = ? WHERE id = ?').run('cancelled', requestId);
  scheduleSave();
  return true;
}

export function setTicketChannel(requestId, channelId) {
  if (!isValidRequestId(requestId)) return;
  db.prepare('UPDATE requests SET ticket_channel_id = ? WHERE id = ?').run(String(channelId), requestId);
  scheduleSave();
}

/**
 * Returns pending requests with unverified screenshots older than maxAgeMinutes.
 * Used by the 5-min auto-close job.
 */
export function getUnverifiedPendingOlderThan(maxAgeMinutes) {
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT id, buyer_id, game_app_id, ticket_channel_id, game_name
    FROM requests
    WHERE status = 'pending'
      AND (screenshot_verified IS NULL OR screenshot_verified = 0)
      AND created_at < ?
  `).all(cutoff);
}
