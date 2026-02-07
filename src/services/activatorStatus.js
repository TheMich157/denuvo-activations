import { db, scheduleSave } from '../db/index.js';

export function setAway(activatorId, away = true) {
  db.prepare(
    `INSERT OR REPLACE INTO activator_status (activator_id, away, updated_at) VALUES (?, ?, datetime('now'))`
  ).run(String(activatorId), away ? 1 : 0);
  scheduleSave();
}

export function isAway(activatorId) {
  const row = db.prepare('SELECT away FROM activator_status WHERE activator_id = ?').get(String(activatorId));
  return row?.away === 1;
}

export function getAvailableActivatorCount() {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT ag.activator_id) AS n
    FROM activator_games ag
    LEFT JOIN activator_status s ON s.activator_id = ag.activator_id
    WHERE (s.away IS NULL OR s.away = 0)
      AND (ag.stock_quantity IS NULL OR ag.stock_quantity > 0)
  `).get();
  return row?.n ?? 0;
}

export function getTotalActivatorCount() {
  const row = db.prepare('SELECT COUNT(DISTINCT activator_id) AS n FROM activator_games').get();
  return row?.n ?? 0;
}
