import { db, scheduleSave } from '../db/index.js';
import { addPoints } from './points.js';

const BASE_REWARD = 15;
const STREAK_BONUS = 5;
const MAX_STREAK_BONUS = 50;
const CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours
const STREAK_EXPIRY_MS = 48 * 60 * 60 * 1000;  // 48 hours — miss a day, streak resets

/**
 * Claim daily reward.
 * @param {string} userId
 * @returns {{ ok: boolean; error?: string; reward?: number; streak?: number; nextClaimAt?: number }}
 */
export function claimDaily(userId) {
  const now = Date.now();
  const row = db.prepare('SELECT last_claimed_at, streak FROM daily_claims WHERE user_id = ?').get(userId);

  if (row) {
    const lastClaimed = new Date(row.last_claimed_at).getTime();
    const elapsed = now - lastClaimed;

    // Too soon — still on cooldown
    if (elapsed < CLAIM_COOLDOWN_MS) {
      const nextClaimAt = lastClaimed + CLAIM_COOLDOWN_MS;
      return { ok: false, error: 'already_claimed', nextClaimAt };
    }

    // Calculate streak
    let streak = (row.streak ?? 0);
    if (elapsed < STREAK_EXPIRY_MS) {
      streak += 1; // Continue streak
    } else {
      streak = 1; // Reset streak — missed the window
    }

    const bonus = Math.min(streak * STREAK_BONUS, MAX_STREAK_BONUS);
    const reward = BASE_REWARD + bonus;

    db.prepare(`
      UPDATE daily_claims SET last_claimed_at = datetime('now'), streak = ? WHERE user_id = ?
    `).run(streak, userId);
    addPoints(userId, reward, 'daily_reward');
    scheduleSave();
    return { ok: true, reward, streak, nextClaimAt: now + CLAIM_COOLDOWN_MS };
  }

  // First ever claim
  const reward = BASE_REWARD;
  db.prepare(`
    INSERT INTO daily_claims (user_id, last_claimed_at, streak) VALUES (?, datetime('now'), 1)
  `).run(userId);
  addPoints(userId, reward, 'daily_reward');
  scheduleSave();
  return { ok: true, reward, streak: 1, nextClaimAt: now + CLAIM_COOLDOWN_MS };
}

/**
 * Get daily claim info without claiming.
 */
export function getDailyInfo(userId) {
  const row = db.prepare('SELECT last_claimed_at, streak FROM daily_claims WHERE user_id = ?').get(userId);
  if (!row) return { canClaim: true, streak: 0, nextReward: BASE_REWARD };

  const lastClaimed = new Date(row.last_claimed_at).getTime();
  const elapsed = Date.now() - lastClaimed;
  const canClaim = elapsed >= CLAIM_COOLDOWN_MS;
  const streakAlive = elapsed < STREAK_EXPIRY_MS;
  const currentStreak = streakAlive ? (row.streak ?? 0) : 0;
  const nextStreak = canClaim ? (streakAlive ? currentStreak + 1 : 1) : currentStreak;
  const bonus = Math.min(nextStreak * STREAK_BONUS, MAX_STREAK_BONUS);

  return {
    canClaim,
    streak: currentStreak,
    nextReward: BASE_REWARD + bonus,
    nextClaimAt: canClaim ? null : lastClaimed + CLAIM_COOLDOWN_MS,
  };
}

export { BASE_REWARD, STREAK_BONUS, MAX_STREAK_BONUS };
