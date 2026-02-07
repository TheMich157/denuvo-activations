/**
 * Stock restock and panel sync configuration.
 * Env: STOCK_RESTOCK_CHECK_INTERVAL_MS
 */
const CHECK_INTERVAL_MS = parseInt(process.env.STOCK_RESTOCK_CHECK_INTERVAL_MS ?? '900000', 10) || 15 * 60 * 1000; // 15 min default

export const stockConfig = {
  restockCheckIntervalMs: Math.max(60_000, Math.min(86400_000, CHECK_INTERVAL_MS)),
};
