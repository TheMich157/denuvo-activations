const windows = new Map();
const CLEANUP_INTERVAL = 60_000;

function getKey(userId, action) {
  return `${String(userId ?? '')}:${String(action ?? '')}`;
}

/**
 * Check if the user is within rate limit. Returns true if allowed, false if limited.
 * @param {string} userId - Discord user ID
 * @param {string} action - Action name (e.g. 'request', 'add')
 * @param {number} maxAttempts - Max attempts per window
 * @param {number} windowMs - Window in milliseconds
 */
export function checkRateLimit(userId, action, maxAttempts = 5, windowMs = 60_000) {
  if (!userId || maxAttempts < 1 || windowMs < 1000) return false;
  const key = getKey(userId, action);
  const now = Date.now();
  let entry = windows.get(key);

  if (!entry) {
    entry = { count: 0, resetAt: now + windowMs };
    windows.set(key, entry);
  }

  if (now >= entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count++;
  return entry.count <= maxAttempts;
}

export function getRemainingCooldown(userId, action) {
  const key = getKey(userId, action);
  const entry = windows.get(key);
  if (!entry) return 0;
  const remaining = entry.resetAt - Date.now();
  return Math.max(0, Math.ceil(remaining / 1000));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of windows.entries()) {
    if (now >= entry.resetAt) windows.delete(key);
  }
}, CLEANUP_INTERVAL);
