import { db, scheduleSave } from '../db/index.js';
import { isValidDiscordId } from '../utils/validate.js';

/**
 * Record an activation today for streak tracking.
 * Call this after a successful activation is completed.
 * @param {string} activatorId
 */
export function recordStreakActivity(activatorId) {
  if (!isValidDiscordId(activatorId)) return;
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    'SELECT current_streak, longest_streak, last_active_date FROM activator_streaks WHERE activator_id = ?'
  ).get(activatorId);

  if (!row) {
    db.prepare(
      'INSERT INTO activator_streaks (activator_id, current_streak, longest_streak, last_active_date) VALUES (?, 1, 1, ?)'
    ).run(activatorId, today);
    scheduleSave();
    return;
  }

  if (row.last_active_date === today) return; // already recorded today

  const lastDate = row.last_active_date ? new Date(row.last_active_date + 'T00:00:00Z') : null;
  const todayDate = new Date(today + 'T00:00:00Z');
  const diffDays = lastDate ? Math.round((todayDate - lastDate) / (24 * 60 * 60 * 1000)) : Infinity;

  let newStreak;
  if (diffDays === 1) {
    newStreak = (row.current_streak ?? 0) + 1;
  } else {
    newStreak = 1; // streak broken
  }
  const longest = Math.max(newStreak, row.longest_streak ?? 0);
  db.prepare(
    'UPDATE activator_streaks SET current_streak = ?, longest_streak = ?, last_active_date = ?, updated_at = datetime(\'now\') WHERE activator_id = ?'
  ).run(newStreak, longest, today, activatorId);
  scheduleSave();
}

/**
 * Get streak info for an activator.
 * @param {string} activatorId
 * @returns {{ current: number; longest: number; lastActiveDate: string|null }}
 */
export function getStreakInfo(activatorId) {
  if (!isValidDiscordId(activatorId)) return { current: 0, longest: 0, lastActiveDate: null };
  const row = db.prepare(
    'SELECT current_streak, longest_streak, last_active_date FROM activator_streaks WHERE activator_id = ?'
  ).get(activatorId);
  if (!row) return { current: 0, longest: 0, lastActiveDate: null };

  // Check if streak is still active (last active was today or yesterday)
  const today = new Date().toISOString().slice(0, 10);
  const todayDate = new Date(today + 'T00:00:00Z');
  const lastDate = row.last_active_date ? new Date(row.last_active_date + 'T00:00:00Z') : null;
  const diffDays = lastDate ? Math.round((todayDate - lastDate) / (24 * 60 * 60 * 1000)) : Infinity;

  const current = diffDays <= 1 ? (row.current_streak ?? 0) : 0;
  return {
    current,
    longest: row.longest_streak ?? 0,
    lastActiveDate: row.last_active_date,
  };
}

/**
 * Get the streak bonus points for an activator's current streak.
 * @param {number} streakDays
 * @returns {number} bonus points
 */
export function getStreakBonus(streakDays) {
  if (streakDays >= 30) return 25;
  if (streakDays >= 14) return 15;
  if (streakDays >= 7) return 10;
  if (streakDays >= 3) return 5;
  return 0;
}
