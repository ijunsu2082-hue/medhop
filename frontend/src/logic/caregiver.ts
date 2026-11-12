// Pure helpers for the Caregiver page (SPEC 10.5): dates on events not from today, simulator labels on run
// events, "Last run result" limited to today, and the dose time on reminder rows. Tested in logic.test.ts.

import type { CareEvent, DoseToday } from "../api/types";
import { abortText, blockerText, doseStatusLine } from "../text/wording";
import { formatClock } from "./time";

/** Event types that describe a flight (a station run or a hover test). */
const FLIGHT_EVENTS = new Set(["run_started", "arrived_at_station", "run_aborted", "hover_test"]);

/** Local calendar date "YYYY-MM-DD" of a unix timestamp (seconds), or null when it is not a usable number. */
export function localDateOf(ts: number): string | null {
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** The event's local date when it is not `today` (care.date_local), else null. */
export function eventDateIfNotToday(e: Pick<CareEvent, "ts">, today: string): string | null {
  const date = localDateOf(e.ts);
  return date && date !== today ? date : null;
}

/** "14:30", or "2026-11-10 14:30" for an event that is not from today. */
export function eventWhen(e: Pick<CareEvent, "ts" | "time_local">, today: string): string {
  const date = eventDateIfNotToday(e, today);
  return date ? `${date} ${e.time_local}` : e.time_local;
}

/** True for a flight event that came from the simulator (`detail.mode === "sim"`). */
export function isSimulatorRunEvent(e: Pick<CareEvent, "type" | "detail">): boolean {
  return FLIGHT_EVENTS.has(e.type) && e.detail?.mode === "sim";
}

/** " (simulator)" for a simulator flight event, else "". */
export function simulatorSuffix(e: Pick<CareEvent, "type" | "detail">): string {
  return isSimulatorRunEvent(e) ? " (simulator)" : "";
}

/** Why a scheduled automatic flight did not start: codes only the scheduler sends. Lower case, to follow "Not started: ". */
export const AUTO_SKIP_TEXT: Record<string, string> = {
  stale_due: "the dose time had already passed",
  not_ready: "the drone was not marked ready",
  already_arrived: "the drone had already arrived at the station for this dose",
};

function skipReason(code: string): string {
  const known = Object.prototype.hasOwnProperty.call(AUTO_SKIP_TEXT, code) ? AUTO_SKIP_TEXT[code] : undefined;
  if (known) return known;
  const t = blockerText(code).trim().replace(/\.$/, "");
  return t.charAt(0).toLowerCase() + t.slice(1);
}

/** Extra text for an event row. reminder_due / needs_attention show the dose time: "due 08:00, logged 14:30". */
export function eventDetailText(e: CareEvent): string | null {
  const d = e.detail ?? {};
  if (e.type === "run_aborted") return abortText(typeof d.reason === "string" ? d.reason : null);
  if (e.type === "run_started" && d.automatic === true) return "Automatic";
  if (e.type === "auto_run_skipped") {
    const codes = Array.isArray(d.blockers) ? d.blockers.map(String).filter((c) => c.trim()) : [];
    return codes.length ? `Not started: ${codes.map(skipReason).join("; ")}.` : null;
  }
  if (e.type === "hover_test" && typeof d.pass === "boolean") return d.pass ? "Passed" : "Did not pass";
  if ((e.type === "reminder_due" || e.type === "needs_attention") && typeof d.time === "string" && d.time.trim()) {
    return `due ${d.time.trim()}, logged ${e.time_local}`;
  }
  return null;
}

/**
 * "Last run result" for the Drone summary: the newest arrival or abort in the events (newest first). A run from
 * today shows its time; an older one shows its date too, so it is never mistaken for today's.
 */
export function lastRunResult(events: CareEvent[] | null, today: string): string {
  const ev = (events ?? []).find((e) => e.type === "arrived_at_station" || e.type === "run_aborted");
  if (!ev) return events === null ? "Loading." : "No run in the recent events.";
  const date = eventDateIfNotToday(ev, today);
  const when = date ? `${ev.time_local} on ${date} (not today)` : ev.time_local;
  const sim = simulatorSuffix(ev);
  if (ev.type === "arrived_at_station") return `Arrived at station at ${when}${sim}`;
  const reason = typeof ev.detail?.reason === "string" ? ev.detail.reason : null;
  return `Stopped early at ${when}${sim}: ${abortText(reason)}`;
}

/**
 * The Status cell of the doses table: the dose status line, with " (simulator)" after it when the line shows an
 * arrival at the station that came from a simulator run (`arrived_mode === "sim"`).
 */
export function doseTableStatusLine(
  d: Pick<DoseToday, "status" | "arrived_at" | "acknowledged_at" | "arrived_mode">,
): string {
  const line = doseStatusLine(d);
  const showsArrival = d.status === "arrived" || (d.status === "needs_attention" && formatClock(d.arrived_at) !== null);
  return showsArrival && d.arrived_mode === "sim" ? `${line} (simulator)` : line;
}
