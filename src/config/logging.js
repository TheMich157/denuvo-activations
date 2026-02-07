/**
 * Logging channel and audit configuration.
 * Env: LOG_CHANNEL_ID — Discord channel ID for activation/ticket audit logs.
 */
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID ?? '1469597575211389040';

export const loggingConfig = {
  logChannelId: LOG_CHANNEL_ID || null,
};
