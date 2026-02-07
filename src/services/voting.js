import { db, scheduleSave } from '../db/index.js';

/**
 * Suggest a game for voting.
 */
export function suggestGame(gameName, userId) {
  const existing = db.prepare('SELECT id, votes FROM game_votes WHERE LOWER(game_name) = LOWER(?)').get(gameName);
  if (existing) {
    // Just add a vote
    voteForGame(existing.id, userId);
    return { id: existing.id, isNew: false };
  }
  db.prepare('INSERT INTO game_votes (game_name, suggested_by) VALUES (?, ?)').run(gameName, userId);
  scheduleSave();
  const row = db.prepare('SELECT last_insert_rowid() AS id').get();
  const id = row?.id;
  voteForGame(id, userId);
  return { id, isNew: true };
}

/**
 * Vote for a game suggestion.
 */
export function voteForGame(voteId, userId) {
  try {
    db.prepare('INSERT OR IGNORE INTO game_vote_users (vote_id, user_id) VALUES (?, ?)').run(voteId, userId);
    const count = db.prepare('SELECT COUNT(*) AS n FROM game_vote_users WHERE vote_id = ?').get(voteId);
    db.prepare('UPDATE game_votes SET votes = ? WHERE id = ?').run(count?.n ?? 1, voteId);
    scheduleSave();
    return true;
  } catch { return false; }
}

/**
 * Get top voted games.
 */
export function getTopVotes(limit = 15) {
  return db.prepare('SELECT * FROM game_votes WHERE status = ? ORDER BY votes DESC LIMIT ?').all('open', limit);
}

/**
 * Check if user already voted for a suggestion.
 */
export function hasVoted(voteId, userId) {
  return !!db.prepare('SELECT 1 FROM game_vote_users WHERE vote_id = ? AND user_id = ?').get(voteId, userId);
}

/**
 * Close a vote (game added or rejected).
 */
export function closeVote(voteId, status = 'added') {
  db.prepare('UPDATE game_votes SET status = ? WHERE id = ?').run(status, voteId);
  scheduleSave();
}

export function getVote(voteId) {
  return db.prepare('SELECT * FROM game_votes WHERE id = ?').get(voteId);
}
