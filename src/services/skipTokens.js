import { db, scheduleSave } from '../db/index.js';

const SKIP_TOKEN_COST = 200; // points to buy one skip token

/**
 * Get a user's skip token count.
 */
export function getTokens(userId) {
  const row = db.prepare('SELECT tokens FROM skip_tokens WHERE user_id = ?').get(userId);
  return row?.tokens ?? 0;
}

/**
 * Add skip tokens to a user.
 */
export function addTokens(userId, count = 1) {
  db.prepare(`
    INSERT INTO skip_tokens (user_id, tokens) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET tokens = tokens + ?
  `).run(userId, count, count);
  scheduleSave();
}

/**
 * Use one skip token (returns true if successful).
 */
export function useToken(userId) {
  const current = getTokens(userId);
  if (current <= 0) return false;
  db.prepare('UPDATE skip_tokens SET tokens = tokens - 1 WHERE user_id = ?').run(userId);
  scheduleSave();
  return true;
}

/**
 * Buy a skip token with points.
 * Returns { ok, error? }
 */
export function buyToken(userId) {
  // Inline point check to avoid circular deps
  const userRow = db.prepare('SELECT points FROM users WHERE id = ?').get(userId);
  const points = userRow?.points ?? 0;
  if (points < SKIP_TOKEN_COST) {
    return { ok: false, error: `Not enough points. You need **${SKIP_TOKEN_COST}** points (you have **${points}**).` };
  }
  db.prepare('UPDATE users SET points = points - ?, updated_at = datetime(\'now\') WHERE id = ?').run(SKIP_TOKEN_COST, userId);
  db.prepare(`
    INSERT INTO point_transactions (user_id, amount, type) VALUES (?, ?, 'skip_token_purchase')
  `).run(userId, -SKIP_TOKEN_COST);
  addTokens(userId, 1);
  scheduleSave();
  return { ok: true, cost: SKIP_TOKEN_COST, remaining: points - SKIP_TOKEN_COST };
}

export { SKIP_TOKEN_COST };
