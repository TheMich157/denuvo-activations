import { processRestockQueue, cleanupOldRestockEntries } from './activators.js';
import { syncPanelMessage } from './panel.js';
import { buildPanelMessagePayload } from '../commands/ticketpanel.js';
import { stockConfig } from '../config/stock.js';
import { debug } from '../utils/debug.js';

const log = debug('stockRestock');
let intervalId = null;
let clientRef = null;

export function startStockRestock(client) {
  clientRef = client;
  if (intervalId) clearInterval(intervalId);
  processRestockQueue();
  cleanupOldRestockEntries();
  const intervalMs = stockConfig.restockCheckIntervalMs;
  intervalId = setInterval(async () => {
    cleanupOldRestockEntries();
    const n = processRestockQueue();
    if (n > 0 && clientRef) {
      log(`Restocked ${n} activation slot(s)`);
      try {
        await syncPanelMessage(clientRef, buildPanelMessagePayload());
      } catch (err) {
        log('Panel sync after restock failed:', err?.message);
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
