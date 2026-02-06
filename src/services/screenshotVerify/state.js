/**
 * Per-channel screenshot verification state.
 * Persists partial progress and failure count between screenshots.
 * State is in-memory; cleared when ticket is closed/cancelled.
 */

/** @type {Map<string, { hasProperties: boolean; hasWub: boolean; failCount: number; manualVerified?: boolean }>} */
const state = new Map();

/**
 * @param {string} channelId
 * @returns {{ hasProperties: boolean; hasWub: boolean; failCount: number; manualVerified?: boolean } | null}
 */
export function getState(channelId) {
  return state.get(channelId) ?? null;
}

/**
 * @param {string} channelId
 * @param {{ hasProperties?: boolean; hasWub?: boolean; failCount?: number; manualVerified?: boolean }} update
 */
export function setState(channelId, update) {
  const current = state.get(channelId) ?? { hasProperties: false, hasWub: false, failCount: 0 };
  const next = {
    hasProperties: update.hasProperties ?? current.hasProperties,
    hasWub: update.hasWub ?? current.hasWub,
    failCount: update.failCount ?? current.failCount,
    manualVerified: update.manualVerified ?? current.manualVerified,
  };
  state.set(channelId, next);
  return next;
}

/**
 * Merge new detection with saved state.
 * @param {string} channelId
 * @param {{ hasProperties: boolean; hasWub: boolean }} detection
 * @returns {{ hasProperties: boolean; hasWub: boolean; isNewProgress: boolean }}
 */
export function mergeDetection(channelId, detection) {
  const saved = getState(channelId);
  const merged = {
    hasProperties: (saved?.hasProperties ?? false) || detection.hasProperties,
    hasWub: (saved?.hasWub ?? false) || detection.hasWub,
    isNewProgress:
      (detection.hasProperties && !(saved?.hasProperties ?? false)) ||
      (detection.hasWub && !(saved?.hasWub ?? false)),
  };
  return merged;
}

/**
 * Increment failure count and save merged progress.
 * @param {string} channelId
 * @param {{ hasProperties: boolean; hasWub: boolean }} merged
 * @returns {number} New fail count
 */
export function recordFailure(channelId, merged) {
  const current = state.get(channelId) ?? { hasProperties: false, hasWub: false, failCount: 0 };
  const failCount = current.failCount + 1;
  setState(channelId, {
    hasProperties: merged.hasProperties,
    hasWub: merged.hasWub,
    failCount,
  });
  return failCount;
}

/**
 * Save merged progress without incrementing fail count (on partial success).
 * @param {string} channelId
 * @param {{ hasProperties: boolean; hasWub: boolean }} merged
 */
export function saveProgress(channelId, merged) {
  const current = state.get(channelId) ?? { hasProperties: false, hasWub: false, failCount: 0 };
  setState(channelId, {
    hasProperties: merged.hasProperties,
    hasWub: merged.hasWub,
    failCount: current.failCount,
  });
}

/**
 * Clear state for channel (e.g. on ticket close).
 * @param {string} channelId
 */
export function clearState(channelId) {
  state.delete(channelId);
}
