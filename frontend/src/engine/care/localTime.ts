// Local wall-clock time as backend/medhop/care uses it: naive `datetime` values in the machine's time zone.
//
// The TypeScript port passes `now` as a Date. Python compares and adds naive datetimes by their
// wall-clock fields (not by instant), so comparisons here go through naiveMs(), which reads the
// local fields of a Date as if they were UTC: exactly naive datetime arithmetic, also on a day when
// the clocks change. Conversions between a Date and a unix timestamp follow CPython 3.12:
//   datetime.timestamp()        whole seconds + microsecond / 1e6 (timestampOf)
//   datetime.fromtimestamp(t)   the fraction rounded to microseconds, half to even (localFields)
// A Date carries milliseconds, so a microsecond part below 1 ms is not represented.

/** The local calendar fields of a moment, with the second as Python shows it (second + microsecond / 1e6). */
export interface LocalFields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

/** A local wall-clock time: Python's datetime(year, month, day, hour, minute, second). `second` may have a fraction. */
export function localDate(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  const whole = Math.floor(second);
  const ms = Math.round((second - whole) * 1000);
  const d = new Date(2000, 0, 1, 0, 0, 0, 0);
  d.setFullYear(year, month - 1, day);
  d.setHours(hour, minute, whole, ms);
  return d;
}

/** The local fields of a Date read as UTC milliseconds: naive datetime arithmetic and comparison. */
export function naiveMs(d: Date): number {
  const utc = new Date(0);
  utc.setUTCFullYear(d.getFullYear(), d.getMonth(), d.getDate());
  utc.setUTCHours(d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
  return utc.getTime();
}

/** (a - b).total_seconds() for two naive local datetimes. */
export function wallSecondsBetween(a: Date, b: Date): number {
  return (naiveMs(a) - naiveMs(b)) / 1000;
}

/** Python's naive datetime.timestamp(): whole seconds plus microsecond / 1e6, added as CPython does. */
export function timestampOf(d: Date): number {
  const ms = d.getTime();
  const seconds = Math.floor(ms / 1000);
  const micro = (ms - seconds * 1000) * 1000;
  return seconds + micro / 1e6;
}

/** datetime.fromtimestamp(ts) as local fields: the fraction rounded to whole microseconds, half to even. */
export function localFields(ts: number): LocalFields {
  let whole = Math.trunc(ts);
  let micro = roundHalfEven((ts - whole) * 1e6);
  if (micro >= 1_000_000) {
    whole += 1;
    micro -= 1_000_000;
  } else if (micro < 0) {
    whole -= 1;
    micro += 1_000_000;
  }
  const d = new Date(whole * 1000);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds() + micro / 1e6,
    microsecond: micro,
  };
}

function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** datetime.fromtimestamp(ts) as a Date (to the millisecond; localFields keeps the microseconds). */
export function fromTimestamp(ts: number): Date {
  const whole = Math.floor(ts);
  const micro = roundHalfEven((ts - whole) * 1e6);
  return new Date(whole * 1000 + Math.floor(micro / 1000));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** strftime("%H:%M") */
export function formatHourMinute(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** strftime("%Y-%m-%d") (four-digit years, as for any date this program sees) */
export function formatDate(d: Date): string {
  return `${String(d.getFullYear()).padStart(4, "0")}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** time_local() of store.py: a unix timestamp as local "HH:MM". */
export function timeLocal(ts: number): string {
  const f = localFields(ts);
  return `${pad2(f.hour)}:${pad2(f.minute)}`;
}

/** The local midnight that starts the day of `d`, and `days` later (days may be negative). */
export function localMidnight(d: Date, days = 0): Date {
  return localDate(d.getFullYear(), d.getMonth() + 1, d.getDate() + days);
}
