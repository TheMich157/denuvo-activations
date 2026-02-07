import { db, scheduleSave } from '../db/index.js';

// ─── XP Configuration ──────────────────────────────────────────
const XP_PER_MESSAGE_MIN = 15;
const XP_PER_MESSAGE_MAX = 25;
const XP_COOLDOWN_MS = 60_000; // 1 message per minute earns XP
const XP_PER_ACTIVATION = 100; // bonus XP when a user completes an activation
const XP_PER_TICKET_COMPLETE = 50; // bonus XP for completing a ticket

// XP required for a given level:  5 * (level^2) + 50 * level + 100
export function xpForLevel(level) {
  return 5 * (level * level) + 50 * level + 100;
}

// Total cumulative XP needed to reach a level
export function totalXpForLevel(level) {
  let total = 0;
  for (let i = 0; i < level; i++) {
    total += xpForLevel(i);
  }
  return total;
}

// ─── Database helpers ───────────────────────────────────────────

function ensureRow(userId) {
  db.prepare(`
    INSERT INTO user_levels (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING
  `).run(String(userId));
}

export function getUserLevel(userId) {
  ensureRow(userId);
  return db.prepare('SELECT * FROM user_levels WHERE user_id = ?').get(String(userId));
}

export function getLeaderboard(limit = 10) {
  return db.prepare(`
    SELECT user_id, xp, level, total_messages
    FROM user_levels
    ORDER BY level DESC, xp DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Get a user's rank position (1-based) on the leaderboard.
 * Uses a SQL COUNT to avoid loading all rows into memory.
 */
export function getUserRank(userId) {
  const uid = String(userId);
  const user = db.prepare('SELECT level, xp FROM user_levels WHERE user_id = ?').get(uid);
  if (!user) return null;
  const row = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM user_levels
    WHERE (level > ? OR (level = ? AND xp > ?))
  `).get(user.level, user.level, user.xp);
  return row?.rank ?? null;
}

/**
 * Get total number of tracked users.
 */
export function getTotalTracked() {
  const row = db.prepare('SELECT COUNT(*) as count FROM user_levels WHERE level > 0 OR xp > 0').get();
  return row?.count ?? 0;
}

// ─── XP Granting ────────────────────────────────────────────────

/**
 * Awards message XP to a user. Returns { leveledUp, oldLevel, newLevel } or null if on cooldown.
 */
export function addMessageXp(userId) {
  ensureRow(userId);
  const row = getUserLevel(userId);

  // Cooldown check
  if (row.last_xp_at) {
    const lastXp = new Date(row.last_xp_at + 'Z').getTime();
    if (Date.now() - lastXp < XP_COOLDOWN_MS) return null;
  }

  const xpGain = Math.floor(Math.random() * (XP_PER_MESSAGE_MAX - XP_PER_MESSAGE_MIN + 1)) + XP_PER_MESSAGE_MIN;
  const newXp = row.xp + xpGain;
  const newMessages = row.total_messages + 1;

  // Check for level up
  let currentLevel = row.level;
  let tempXp = newXp;
  let leveledUp = false;

  while (tempXp >= xpForLevel(currentLevel)) {
    tempXp -= xpForLevel(currentLevel);
    currentLevel++;
    leveledUp = true;
  }

  db.prepare(`
    UPDATE user_levels SET xp = ?, level = ?, total_messages = ?, last_xp_at = datetime('now')
    WHERE user_id = ?
  `).run(leveledUp ? tempXp : newXp, currentLevel, newMessages, String(userId));
  scheduleSave();

  return {
    leveledUp,
    oldLevel: row.level,
    newLevel: currentLevel,
    xp: leveledUp ? tempXp : newXp,
    xpGain,
  };
}

/**
 * Awards bonus XP (activation, ticket complete, etc). Returns { leveledUp, oldLevel, newLevel }.
 */
export function addBonusXp(userId, amount) {
  ensureRow(userId);
  const row = getUserLevel(userId);
  const newXp = row.xp + amount;

  let currentLevel = row.level;
  let tempXp = newXp;
  let leveledUp = false;

  while (tempXp >= xpForLevel(currentLevel)) {
    tempXp -= xpForLevel(currentLevel);
    currentLevel++;
    leveledUp = true;
  }

  db.prepare(`
    UPDATE user_levels SET xp = ?, level = ? WHERE user_id = ?
  `).run(leveledUp ? tempXp : newXp, currentLevel, String(userId));
  scheduleSave();

  return {
    leveledUp,
    oldLevel: row.level,
    newLevel: currentLevel,
    xp: leveledUp ? tempXp : newXp,
    xpGain: amount,
  };
}

// ─── Staff Overrides ────────────────────────────────────────────

/**
 * Directly set a user's level (resets current XP within that level to 0).
 */
export function setLevel(userId, level) {
  ensureRow(userId);
  db.prepare(`
    UPDATE user_levels SET level = ?, xp = 0 WHERE user_id = ?
  `).run(level, String(userId));
  scheduleSave();
}

/**
 * Directly set a user's XP within their current level.
 */
export function setXp(userId, xp) {
  ensureRow(userId);
  const row = getUserLevel(userId);
  let currentLevel = row.level;
  let tempXp = xp;

  // If the new XP exceeds current level requirement, level up
  while (tempXp >= xpForLevel(currentLevel)) {
    tempXp -= xpForLevel(currentLevel);
    currentLevel++;
  }

  db.prepare(`
    UPDATE user_levels SET xp = ?, level = ? WHERE user_id = ?
  `).run(tempXp, currentLevel, String(userId));
  scheduleSave();
  return { level: currentLevel, xp: tempXp };
}

/**
 * Reset a user's leveling data entirely.
 */
export function resetLevel(userId) {
  db.prepare(`
    UPDATE user_levels SET xp = 0, level = 0, total_messages = 0, last_xp_at = NULL WHERE user_id = ?
  `).run(String(userId));
  scheduleSave();
}

// ─── Level-up visual helpers ────────────────────────────────────

const RANK_TITLES = [
  { min: 60, title: 'Mythic',    emoji: '\uD83C\uDFC6' },
  { min: 50, title: 'Legendary', emoji: '\uD83D\uDD25' },
  { min: 40, title: 'Master',    emoji: '\u2B50' },
  { min: 30, title: 'Expert',    emoji: '\uD83D\uDCA0' },
  { min: 20, title: 'Veteran',   emoji: '\uD83C\uDF96\uFE0F' },
  { min: 15, title: 'Advanced',  emoji: '\uD83D\uDEE1\uFE0F' },
  { min: 10, title: 'Seasoned',  emoji: '\u2694\uFE0F' },
  { min: 5,  title: 'Regular',   emoji: '\uD83D\uDFE2' },
  { min: 2,  title: 'Member',    emoji: '\uD83D\uDFE1' },
  { min: 0,  title: 'Newcomer',  emoji: '\u26AA' },
];

export function getLevelTitle(level) {
  const entry = RANK_TITLES.find(r => level >= r.min);
  return entry?.title ?? 'Newcomer';
}

export function getLevelEmoji(level) {
  const entry = RANK_TITLES.find(r => level >= r.min);
  return entry?.emoji ?? '\u26AA';
}

export function progressBar(current, max, length = 14) {
  const ratio = Math.min(current / Math.max(max, 1), 1);
  const filled = Math.round(ratio * length);
  const empty = length - filled;
  return '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
}

export { XP_PER_ACTIVATION, XP_PER_TICKET_COMPLETE };
