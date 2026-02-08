import { processRestockQueue, cleanupOldData, drainLowStockWarnings } from './activators.js';
import { syncPanelMessage } from './panel.js';
import { buildPanelMessagePayload } from '../commands/ticketpanel.js';
import { stockConfig } from '../config/stock.js';
import { debug } from '../utils/debug.js';
import { logRestockBatch } from './activationLog.js';
import { getGameByAppId } from '../utils/games.js';
import { notifyWaitlistAndClear } from './waitlist.js';

const log = debug('stockRestock');
let intervalId = null;
let clientRef = null;

export function startStockRestock(client) {
  clientRef = client;
  if (intervalId) clearInterval(intervalId);
  const initialRows = processRestockQueue();
  if (initialRows.length > 0) {
    const entries = initialRows.map((r) => ({
      activatorId: r.activator_id,
      gameAppId: r.game_app_id,
      gameName: (getGameByAppId(r.game_app_id) || {}).name || `App ${r.game_app_id}`,
    }));
    logRestockBatch(entries).catch((err) => log('Restock log failed:', err?.message));
  }
  cleanupOldData();
  const intervalMs = stockConfig.restockCheckIntervalMs;
  intervalId = setInterval(async () => {
    cleanupOldData();
    const rows = processRestockQueue();
    if (rows.length > 0) {
      log(`Restocked ${rows.length} activation slot(s)`);
      const entries = rows.map((r) => ({
        activatorId: r.activator_id,
        gameAppId: r.game_app_id,
        gameName: (getGameByAppId(r.game_app_id) || {}).name || `App ${r.game_app_id}`,
      }));
      logRestockBatch(entries).catch((err) => log('Restock log failed:', err?.message));
      if (clientRef) {
        try {
          await syncPanelMessage(clientRef, buildPanelMessagePayload());
        } catch (err) {
          log('Panel sync after restock failed:', err?.message);
        }
        // Notify waitlisted users when games restock
        const restoredGames = new Set(rows.map((r) => r.game_app_id));
        for (const appId of restoredGames) {
          notifyWaitlistAndClear(clientRef, appId).catch(() => {});
        }
      }
    }
    // Send low stock warning DMs
    if (clientRef) {
      const warnings = drainLowStockWarnings();
      for (const w of warnings) {
        try {
          const user = await clientRef.users.fetch(w.activatorId).catch(() => null);
          if (user) {
            await user.send(`⚠️ **Low stock warning** — **${w.gameName}** has only **${w.remaining}** activation${w.remaining !== 1 ? 's' : ''} left. Use \`/add\` to restock.`).catch(() => {});
          }
        } catch {}
      }
    }
  }, intervalMs);
}

export function stopStockRestock() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  clientRef = null;
}
