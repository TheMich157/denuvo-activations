/**
 * Input validation for safety.
 */

const DISCORD_ID_REGEX = /^\d{17,19}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_POINTS = 1_000_000;
const MAX_APP_ID = 2_147_483_647;
const MAX_REASON_LENGTH = 100;

export function isValidDiscordId(id) {
  return typeof id === 'string' && DISCORD_ID_REGEX.test(id);
}

export function isValidRequestId(id) {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

export function isValidAppId(id) {
  const n = parseInt(id, 10);
  return Number.isInteger(n) && n > 0 && n <= MAX_APP_ID;
}

export function isValidPointsAmount(amount) {
  const n = parseInt(amount, 10);
  return Number.isInteger(n) && n > 0 && n <= MAX_POINTS;
}

export function isValidReason(reason) {
  return typeof reason === 'string' && reason.length > 0 && reason.length <= MAX_REASON_LENGTH;
}

export function sanitizeError(err) {
  const msg = err?.message || 'An error occurred';
  const sensitive = /ENCRYPTION|crypto|at\s+\w+|\.js:\d+:\d+|stack\s+trace/i;
  if (sensitive.test(msg)) return 'An internal error occurred. Check server logs.';
  return msg.length > 400 ? msg.slice(0, 397) + '...' : msg;
}
