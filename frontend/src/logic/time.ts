const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Strict 24-hour HH:MM (two digits each, 00:00 to 23:59). */
export function isValidHHMM(value: string): boolean {
  return HHMM.test(value);
}

/** Accept "8:05" or "0805" as a convenience and normalise to "08:05"; return null when not a valid time. */
export function normaliseHHMM(value: string): string | null {
  const v = value.trim();
  if (isValidHHMM(v)) return v;
  let m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) m = /^(\d{2})(\d{2})$/.exec(v);
  if (!m) return null;
  const out = `${m[1]!.padStart(2, "0")}:${m[2]}`;
  return isValidHHMM(out) ? out : null;
}

/**
 * A dose clock time for display. The backend sends local "HH:MM" strings; if a number arrives instead it is
 * taken as unix seconds (or milliseconds when very large) and shown as local HH:MM, never printed raw.
 * Returns null when there is nothing sensible to show.
 */
export function formatClock(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const v = value.trim();
    if (v === "") return null;
    if (/^-?\d+(\.\d+)?$/.test(v)) return formatClock(Number(v));
    return v;
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  const ms = value > 1e11 ? value : value * 1000;
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** True when local clock `now` ("HH:MM") is earlier than `time` ("HH:MM"). Same day, zero-padded strings. */
export function isBeforeClock(now: string, time: string): boolean {
  if (!isValidHHMM(now) || !isValidHHMM(time)) return false;
  return now < time;
}

export function formatSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return "-";
  return `${s.toFixed(1)} s`;
}

export function formatSigned(n: number, digits = 2): string {
  const v = n.toFixed(digits);
  return n > 0 ? `+${v}` : n === 0 ? (0).toFixed(digits) : v;
}
