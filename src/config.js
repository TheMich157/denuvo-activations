import 'dotenv/config';

export const config = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.DISCORD_CLIENT_ID,
  encryptionKey: process.env.ENCRYPTION_KEY,
  activatorRoleId: process.env.ACTIVATOR_ROLE_ID,
  ticketCategoryId: process.env.TICKET_CATEGORY_ID,
  guildId: process.env.GUILD_ID || null,
  dailyActivationLimit: parseInt(process.env.DAILY_ACTIVATION_LIMIT ?? '5', 10),
  pointsPerActivation: parseInt(process.env.POINTS_PER_ACTIVATION ?? '50', 10),
  restockHours: parseInt(process.env.RESTOCK_HOURS ?? '24', 10) || 24,
};

const REQUIRED = ['token', 'clientId', 'activatorRoleId', 'ticketCategoryId'];

export function validateConfig() {
  const missing = REQUIRED.filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(
      `Missing required env vars: ${missing.join(', ')}. See .env.example`
    );
  }
  if (config.encryptionKey && config.encryptionKey.length > 0 && config.encryptionKey.length < 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars');
  }
  const limit = config.dailyActivationLimit;
  const points = config.pointsPerActivation;
  if (!Number.isInteger(limit) || limit < 1 || limit > 999) {
    throw new Error('DAILY_ACTIVATION_LIMIT must be 1–999');
  }
  if (!Number.isInteger(points) || points < 1 || points > 1_000_000) {
    throw new Error('POINTS_PER_ACTIVATION must be 1–1,000,000');
  }
  const restock = config.restockHours;
  if (!Number.isInteger(restock) || restock < 1 || restock > 8760) {
    throw new Error('RESTOCK_HOURS must be 1–8760 (max 1 year)');
  }
}
