// All timestamps are rendered as ISO 8601 UTC so exports are stable across
// machines and locales.

export function isoFromUnixSeconds(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

// Accepts seconds or milliseconds and picks the plausible unit.
export function isoFromEpoch(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "";
  const millis = num > 10_000_000_000 ? num : num * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}
