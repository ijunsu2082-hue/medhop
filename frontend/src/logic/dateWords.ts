// Calendar dates in words, for both care pages. Pure: the weekday comes from the date itself (UTC arithmetic),
// never from the browser's time zone, so the backend's local date reads the same everywhere.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** '2026-11-12' -> 'Thursday 12 November'. Returns null for anything that is not a real YYYY-MM-DD date. */
export function formatDateWords(dateLocal: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLocal.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  // Reject dates that rolled over, such as 2026-02-30.
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return `${WEEKDAYS[d.getUTCDay()]} ${day} ${MONTHS[month - 1]}`;
}
