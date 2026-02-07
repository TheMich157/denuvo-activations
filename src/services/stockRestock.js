import { processRestockQueue, cleanupOldRestockEntries } from './activators.js';
import { syncPanelMessage } from './panel.js';
import { buildPanelMessagePayload } from '../commands/ticketpanel.js';
import { stockConfig } from '../config/stock.js';
import { debug } from '../utils/debug.js';
import { logRestockBatch } from './activationLog.js';
import { getGameByAppId } from '../utils/games.js';

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
  cleanupOldRestockEntries();
  const intervalMs = stockConfig.restockCheckIntervalMs;
  intervalId = setInterval(async () => {
    cleanupOldRestockEntries();
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
