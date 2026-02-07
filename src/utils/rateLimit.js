const windows = new Map();
const CLEANUP_INTERVAL = 60000;

function getKey(userId, action) {
  return `${userId}:${action}`;
}

export function checkRateLimit(userId, action, maxAttempts = 5, windowMs = 60000) {
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
