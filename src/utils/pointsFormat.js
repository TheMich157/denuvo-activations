const CENTS_PER_POINT = 1;
const MAX_SAFE_POINTS = 100000;

function toSafePoints(value) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.min(n, MAX_SAFE_POINTS);
}

/** Convert points to dollars (1 point = 1¢). Safe for null/undefined/NaN. */
export function pointsToDollars(points) {
  return (toSafePoints(points) * CENTS_PER_POINT) / 100;
}

/** Convert dollars to points (rounded). */
export function dollarsToPoints(dollars) {
  const n = Number(dollars);
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.round(Math.min(n * 100, MAX_SAFE_POINTS));
}

/** Format points as money string (e.g. "$12.50"). */
export function formatPointsAsMoney(points) {
  return `$${pointsToDollars(points).toFixed(2)}`;
}

/** Format as "X pts ($Y.YY)". */
export function formatPointsWithValue(points) {
  const safe = toSafePoints(points);
  return `${safe} pts (${formatPointsAsMoney(safe)})`;
}
