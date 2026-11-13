// Ports backend/medhop/care/status.py: per-dose status for today (SPEC section 7).
//
//   upcoming         before the dose time
//   due              from the dose time
//   arrived          a station run for this dose logged `arrived_at_station` today
//   acknowledged     pickup acknowledged today (self-reported; nothing proves a dose was taken)
//   needs_attention  not acknowledged and now is later than dose time + grace (arrived_at is kept)
//
// `arrived_at` and `acknowledged_at` are local "HH:MM" strings (or null). `arrived_mode` is "sim",
// "real" or null, copied from `detail.mode` of the latest `arrived_at_station` event today for the dose.
//
// A station run may arrive before the dose time. The dose is then `arrived` straight away and keeps
// that status, but it is not due yet: the `reminder_due` event is written only when the clock reaches
// the dose time, and `next_due_id` does not point at it while anything else is waiting.
//
// "Today" is the local calendar day, so every status starts again at midnight. This is a known limit,
// carried over from the Python: at 00:00 every dose becomes `upcoming` again, yesterday's events stop
// counting, and a dose whose time + grace falls after midnight (for example 23:50 with 15 minutes of
// grace) never reaches `needs_attention`, so CareMonitor never logs `needs_attention` for it.
//
// `now` is a Date read in local time (Python: a naive local datetime). Every function here is pure
// given `now`; comparisons use the wall-clock fields, as Python compares naive datetimes.

import type { CareStatus, DoseStatus, DoseToday, Mode } from "../../api/types";
import { pyMax, ValueError } from "../util/num";
import {
  formatDate,
  formatHourMinute,
  localDate,
  localMidnight,
  naiveMs,
  timeLocal,
  timestampOf,
} from "./localTime";
import { compareStrings, isJsonObject, pyIntOf, pyTruthy } from "./pyCompat";
import type { CareStore, PublicEvent, StoredEvent } from "./store";

export const UPCOMING = "upcoming" satisfies DoseStatus;
export const DUE = "due" satisfies DoseStatus;
export const ARRIVED = "arrived" satisfies DoseStatus;
export const ACKNOWLEDGED = "acknowledged" satisfies DoseStatus;
export const NEEDS_ATTENTION = "needs_attention" satisfies DoseStatus;
export const STATUSES: readonly DoseStatus[] = [UPCOMING, DUE, ARRIVED, ACKNOWLEDGED, NEEDS_ATTENTION];
/** Python's _PENDING: waiting for pickup. */
export const PENDING: readonly DoseStatus[] = [DUE, ARRIVED, NEEDS_ATTENTION];

/** What dose_statuses reads from a dose. */
export interface DoseLike {
  id: string;
  /** 24-hour HH:MM */
  time: string;
  label: string;
  notes?: string;
}

/** What dose_statuses reads from an event (a StoredEvent has all of it). */
export interface StatusEvent {
  ts: number;
  type: string;
  dose_id?: string | null;
  detail?: unknown;
}

/** One row of dose_statuses (and of care_snapshot's `doses`). */
export interface DoseStatusRow extends DoseToday {
  arrived_at: string | null;
  acknowledged_at: string | null;
  arrived_mode: Mode | null;
}

/** care_snapshot */
export interface CareSnapshot extends CareStatus {
  doses: DoseStatusRow[];
}

/** The store methods care_snapshot reads. */
export type CareStoreReader = Pick<CareStore, "listDoses" | "eventsBetween">;
/** The store methods CareMonitor uses. */
export type CareMonitorStore = Pick<CareStore, "listDoses" | "eventsBetween" | "addEvent">;

/** [start, end) of now's local calendar day, as unix timestamps. */
export function dayBounds(now: Date): [number, number] {
  return [timestampOf(localMidnight(now)), timestampOf(localMidnight(now, 1))];
}

/** int(hour), int(minute) of a dose's "HH:MM" (Python raises ValueError for anything else). */
function hourMinute(dose: { time: string }): [number, number] {
  const parts = dose.time.split(":");
  if (parts.length !== 2) throw new ValueError(`not an HH:MM time: ${dose.time}`);
  const hour = pyIntOf(parts[0]);
  const minute = pyIntOf(parts[1]);
  if (hour === null || minute === null) throw new ValueError(`not an HH:MM time: ${dose.time}`);
  if (hour < 0n || hour > 23n) throw new ValueError("hour must be in 0..23");
  if (minute < 0n || minute > 59n) throw new ValueError("minute must be in 0..59");
  return [Number(hour), Number(minute)];
}

/** The dose time on now's local date as naive wall-clock milliseconds (see naiveMs). */
function doseNaiveMs(dose: { time: string }, now: Date): number {
  const [hour, minute] = hourMinute(dose);
  const utc = new Date(0);
  utc.setUTCFullYear(now.getFullYear(), now.getMonth(), now.getDate());
  utc.setUTCHours(hour, minute, 0, 0);
  return utc.getTime();
}

/** The dose time on now's local date. */
export function doseTimeToday(dose: { time: string }, now: Date): Date {
  const [hour, minute] = hourMinute(dose);
  return localDate(now.getFullYear(), now.getMonth() + 1, now.getDate(), hour, minute);
}

/** (now - dose_time_today(dose, now)).total_seconds(): how late it is for the dose (negative: early). */
export function secondsSinceDoseTime(dose: { time: string }, now: Date): number {
  return (naiveMs(now) - doseNaiveMs(dose, now)) / 1000;
}

/** Pure function. `eventsToday` must only contain events from now's local calendar day. */
export function doseStatuses(
  doses: Iterable<DoseLike>,
  eventsToday: Iterable<StatusEvent>,
  now: Date,
  graceMin: number,
): DoseStatusRow[] {
  const arrived = new Map<string, number>();
  const arrivedMode = new Map<string, Mode | null>();
  const acknowledged = new Map<string, number>();
  for (const event of eventsToday) {
    const doseId = event.dose_id;
    if (!pyTruthy(doseId) || typeof doseId !== "string") continue;
    if (event.type === "arrived_at_station") {
      if (event.ts >= (arrived.get(doseId) ?? 0.0)) {
        arrived.set(doseId, event.ts);
        const detail = event.detail;
        const mode = isJsonObject(detail) ? detail["mode"] : null;
        arrivedMode.set(doseId, mode === "sim" || mode === "real" ? mode : null);
      }
    } else if (event.type === "pickup_acknowledged") {
      acknowledged.set(doseId, pyMax(acknowledged.get(doseId) ?? 0.0, event.ts));
    }
  }

  const nowMs = naiveMs(now);
  const graceMs = graceMin * 60_000;
  const sorted = [...doses].sort((a, b) => compareStrings(a.time, b.time) || compareStrings(a.id, b.id));
  return sorted.map((dose): DoseStatusRow => {
    const at = doseNaiveMs(dose, now);
    const arrivedAt = arrived.get(dose.id);
    const acknowledgedAt = acknowledged.get(dose.id);
    let status: DoseStatus;
    if (acknowledgedAt !== undefined) status = ACKNOWLEDGED;
    else if (nowMs > at + graceMs) status = NEEDS_ATTENTION;
    else if (arrivedAt !== undefined) status = ARRIVED;
    else if (nowMs >= at) status = DUE;
    else status = UPCOMING;
    return {
      id: dose.id,
      time: dose.time,
      label: dose.label,
      notes: dose.notes ?? "",
      status,
      arrived_at: arrivedAt === undefined ? null : timeLocal(arrivedAt),
      arrived_mode: arrivedMode.get(dose.id) ?? null,
      acknowledged_at: acknowledgedAt === undefined ? null : timeLocal(acknowledgedAt),
    };
  });
}

/** True from the dose time on (today). */
export function timeHasCome(dose: { time: string }, now: Date): boolean {
  return naiveMs(now) >= doseNaiveMs(dose, now);
}

/**
 * The dose to show first. `statuses` is the time-ordered output of doseStatuses for `now`.
 *
 * The rule, in order:
 *   1. the earliest dose that is waiting for pickup (due, arrived or needs_attention) AND whose
 *      time has come;
 *   2. else the earliest dose whose time has not come yet and that is not acknowledged: an
 *      upcoming one, or one whose station run arrived early. Among these the order is by dose
 *      time, so an early arrival for the evening does not jump ahead of the midday dose;
 *   3. else null (everything today is acknowledged, or there are no doses).
 */
export function nextDueId(statuses: readonly { id: string; time: string; status: DoseStatus | string }[], now: Date): string | null {
  for (const dose of statuses) {
    if ((PENDING as readonly string[]).includes(dose.status) && timeHasCome(dose, now)) return dose.id;
  }
  for (const dose of statuses) {
    if ((dose.status === UPCOMING || dose.status === ARRIVED) && !timeHasCome(dose, now)) return dose.id;
  }
  return null;
}

export function careSnapshot(store: CareStoreReader, now: Date, graceMin: number): CareSnapshot {
  const [startTs, endTs] = dayBounds(now);
  const statuses = doseStatuses(store.listDoses(), store.eventsBetween(startTs, endTs), now, graceMin);
  return {
    now_local: formatHourMinute(now),
    date_local: formatDate(now),
    doses: statuses,
    next_due_id: nextDueId(statuses, now),
  };
}

function loggedKey(type: string, doseId: string | null | undefined): string {
  return JSON.stringify([type, doseId ?? null]);
}

/**
 * Writes `reminder_due` and `needs_attention` events, at most once per dose per day.
 *
 * `reminder_due` is written when the clock reaches the dose time, never because a station run
 * arrived early, and not at all for a dose that was acknowledged before its time.
 */
export class CareMonitor {
  constructor(
    private readonly store: CareMonitorStore,
    readonly graceMin: number,
  ) {}

  /** The events written by this tick (public form), in dose order. */
  tick(now: Date): PublicEvent[] {
    const [startTs, endTs] = dayBounds(now);
    const events: StoredEvent[] = this.store.eventsBetween(startTs, endTs);
    const logged = new Set(events.map((e) => loggedKey(e.type, e.dose_id)));
    const written: PublicEvent[] = [];
    for (const dose of doseStatuses(this.store.listDoses(), events, now, this.graceMin)) {
      if (dose.status === UPCOMING || dose.status === ACKNOWLEDGED || !timeHasCome(dose, now)) continue;
      if (!logged.has(loggedKey("reminder_due", dose.id))) {
        written.push(
          this.store.addEvent("reminder_due", {
            doseId: dose.id,
            ts: timestampOf(now),
            detail: { time: dose.time, label: dose.label },
          }),
        );
      }
      if (dose.status === NEEDS_ATTENTION && !logged.has(loggedKey("needs_attention", dose.id))) {
        written.push(
          this.store.addEvent("needs_attention", {
            doseId: dose.id,
            ts: timestampOf(now),
            detail: { time: dose.time, label: dose.label, grace_min: this.graceMin },
          }),
        );
      }
    }
    return written;
  }
}

