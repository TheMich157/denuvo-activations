const CENTS_PER_POINT = 1;

export function pointsToDollars(points) {
  return (points * CENTS_PER_POINT) / 100;
}

export function dollarsToPoints(dollars) {
  return Math.round(dollars * 100);
}

export function formatPointsAsMoney(points) {
  return `$${pointsToDollars(points).toFixed(2)}`;
}

export function formatPointsWithValue(points) {
  return `${points} pts (${formatPointsAsMoney(points)})`;
}
