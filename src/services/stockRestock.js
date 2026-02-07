import { processRestockQueue, cleanupOldRestockEntries } from './activators.js';
import { syncPanelMessage } from './panel.js';
import { buildPanelMessagePayload } from '../commands/ticketpanel.js';

const CHECK_INTERVAL_MS = 15 * 60 * 1000;
let intervalId = null;
let clientRef = null;

export function startStockRestock(client) {
  clientRef = client;
  if (intervalId) clearInterval(intervalId);
  processRestockQueue();
  cleanupOldRestockEntries();
  intervalId = setInterval(async () => {
    cleanupOldRestockEntries();
    const n = processRestockQueue();
    if (n > 0 && clientRef) {
      console.log(`[Stock] Restocked ${n} activation slot(s)`);
      try {
        await syncPanelMessage(clientRef, buildPanelMessagePayload());
      } catch {}
    }
  }, CHECK_INTERVAL_MS);
}

export function stopStockRestock() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  clientRef = null;
}
