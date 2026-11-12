import type { CareStatus, DoseToday } from "../api/types";
import { formatClock, isBeforeClock } from "./time";

/** Doses that are due and not yet acknowledged. */
export const PENDING_STATUSES = new Set(["due", "arrived", "needs_attention"]);

export type CareFocus =
  | { kind: "pending"; dose: DoseToday }
  | { kind: "upcoming"; dose: DoseToday }
  | { kind: "all_done" }
  | { kind: "none_scheduled" };

function byTime(a: DoseToday, b: DoseToday): number {
  return a.time.localeCompare(b.time);
}

/** Statuses where a station arrival (arrived_at) puts the dose first on the Care page. */
const ARRIVAL_STATUSES = new Set(["arrived", "needs_attention"]);

/**
 * What the older-adult page shows, one thing at a time:
 * 1. a pending dose (due / arrived / needs_attention): one the drone has reached the station for (status arrived,
 *    or needs_attention with arrived_at) if any, the most recent arrival first; else next_due_id if it is pending,
 *    else the earliest pending;
 * 2. otherwise the next upcoming dose: next_due_id if it is upcoming, else the earliest upcoming;
 * 3. otherwise "all done" (every dose acknowledged) or "none scheduled".
 * `justAcknowledged` is a dose this page acknowledged moments ago: it is no longer pending even if the status
 * snapshot has not caught up, so the page moves on to the next dose instead of offering it again.
 */
export function careFocus(care: CareStatus, justAcknowledged: string | null = null): CareFocus {
  const doses = [...care.doses].sort(byTime);
  if (doses.length === 0) return { kind: "none_scheduled" };
  const isPending = (d: DoseToday) => PENDING_STATUSES.has(d.status) && d.id !== justAcknowledged;
  const hinted = care.next_due_id ? doses.find((d) => d.id === care.next_due_id) : undefined;
  const pending = doses.filter(isPending);
  if (pending.length > 0) {
    let latestArrival: { dose: DoseToday; at: string } | null = null;
    for (const d of pending) {
      const at = ARRIVAL_STATUSES.has(d.status) ? formatClock(d.arrived_at) : null;
      if (at !== null && (latestArrival === null || at >= latestArrival.at)) latestArrival = { dose: d, at };
    }
    if (latestArrival) return { kind: "pending", dose: latestArrival.dose };
    const dose = hinted && isPending(hinted) ? hinted : pending[0]!;
    return { kind: "pending", dose };
  }
  const upcoming = doses.filter((d) => d.status === "upcoming");
  if (upcoming.length > 0) {
    const dose = hinted && hinted.status === "upcoming" ? hinted : upcoming[0]!;
    return { kind: "upcoming", dose };
  }
  return { kind: "all_done" };
}

/**
 * A station run can arrive before the dose time. Such a dose has status `arrived` while the clock is still
 * earlier than its time: the page says the drone reached the station, but it is not "time" yet.
 */
export function isEarlyArrival(dose: DoseToday, nowLocal: string): boolean {
  return dose.status === "arrived" && isBeforeClock(nowLocal, dose.time);
}

/**
 * Whether the "it is time" reminder may be spoken for this dose now: only for a pending dose, and never
 * before its time (an early arrival waits until `care.now_local` reaches the dose time).
 */
export function reminderMaySpeak(dose: DoseToday, nowLocal: string): boolean {
  if (!PENDING_STATUSES.has(dose.status)) return false;
  return !isBeforeClock(nowLocal, dose.time);
}

/**
 * "The drone reached the station at 08:12", with "(simulator) " in front when the arrival came from a simulator
 * run. Only what the system knows: the drone reached the station sign. Null when the dose has no arrival.
 */
export function arrivalLine(dose: Pick<DoseToday, "arrived_at" | "arrived_mode">): string | null {
  if (dose.arrived_at === null || dose.arrived_at === undefined) return null;
  const at = formatClock(dose.arrived_at);
  const prefix = dose.arrived_mode === "sim" ? "(simulator) " : "";
  return at ? `${prefix}The drone reached the station at ${at}` : `${prefix}The drone reached the station`;
}

/** The sentence spoken aloud for a pending dose. Plain words, no jargon. */
export function spokenReminder(dose: DoseToday): string {
  const parts = [`It is time for: ${dose.label}.`];
  const arrival = arrivalLine(dose);
  if (arrival) parts.push(`${arrival}.`);
  parts.push("When you have picked it up, press the button that says I picked it up.");
  return parts.join(" ");
}

/** Ids of doses that moved into `needs_attention` between two snapshots (first snapshot: nothing). */
export function newlyNeedingAttention(prev: Map<string, string> | null, doses: DoseToday[]): DoseToday[] {
  if (!prev) return [];
  return doses.filter((d) => d.status === "needs_attention" && prev.get(d.id) !== "needs_attention");
}

/** After "I picked it up" succeeds, the button stays disabled this long so a second tap cannot acknowledge the next dose. */
export const ACK_COOLDOWN_MS = 3000;
