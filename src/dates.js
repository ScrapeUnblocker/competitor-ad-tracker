/** Calendar-day helpers. Every date in the tracker is a UTC "YYYY-MM-DD" string. */

const DAY_MS = 86_400_000;

/** "2026-11-12T14:41:59Z" or "2026-11-12" -> "2026-11-12"; anything else -> null. */
export function isoDate(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1] : null;
}

export function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (both "YYYY-MM-DD"); negative when b is before a. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

export function addDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** "2026-11-12" -> "12 Nov" (or "12 Nov 2025" when the year differs from `today`). */
export function shortDate(date, today) {
  if (!date) return "?";
  const d = new Date(`${date}T00:00:00Z`);
  const month = d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  const year = today && today.slice(0, 4) !== date.slice(0, 4) ? ` ${date.slice(0, 4)}` : "";
  return `${d.getUTCDate()} ${month}${year}`;
}
