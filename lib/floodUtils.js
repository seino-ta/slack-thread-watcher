const DEFAULT_WINDOW_SEC = 60;

export function ensureWindowMs(windowSec) {
  const numeric = Number(windowSec);
  if (!Number.isFinite(numeric) || numeric < 1) {
    return DEFAULT_WINDOW_SEC * 1000;
  }
  return Math.floor(numeric) * 1000;
}

export function trimTimestamps(timestamps, windowMs, referenceTime = Date.now()) {
  if (!Array.isArray(timestamps)) return [];
  const window =
    typeof windowMs === "number" && windowMs > 0
      ? windowMs
      : ensureWindowMs(DEFAULT_WINDOW_SEC);
  const threshold = referenceTime - window;
  return timestamps.filter(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= threshold,
  );
}
