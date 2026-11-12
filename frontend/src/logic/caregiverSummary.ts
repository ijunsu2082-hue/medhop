// Pure helpers for the Caregiver page's daily report: the headline that states the day, the counts line under it,
// and the split of a dose status line into its state word and its detail. Tested in caregiverSummary.test.ts.
// The status lines themselves come unchanged from doseTableStatusLine (logic/caregiver.ts); this file only splits them.

import type { DoseStatus } from "../api/types";

type DoseLike = { status: DoseStatus | string };

export interface DayCounts {
  total: number;
  needsAttention: number;
  /** Due now, or the drone has arrived at the station and the pickup is not yet acknowledged. */
  dueOrArrived: number;
  acknowledged: number;
  upcoming: number;
}

export function dayCounts(doses: readonly DoseLike[]): DayCounts {
  const count = (...statuses: string[]) => doses.filter((d) => statuses.includes(d.status)).length;
  return {
    total: doses.length,
    needsAttention: count("needs_attention"),
    dueOrArrived: count("due", "arrived"),
    acknowledged: count("acknowledged"),
    upcoming: count("upcoming"),
  };
}

/**
 * One sentence that states the day, from the counts only, in order of what matters most:
 * needs attention, then all acknowledged, then due now, then still to come.
 */
export function dayHeadline(doses: readonly DoseLike[]): string {
  const c = dayCounts(doses);
  const n = c.total;
  if (n === 0) return "No doses scheduled today";
  if (c.needsAttention > 0) {
    if (n === 1) return "Today's dose needs attention";
    return `${c.needsAttention} of ${n} doses ${c.needsAttention === 1 ? "needs" : "need"} attention`;
  }
  if (c.acknowledged === n) return n === 1 ? "Today's dose is acknowledged" : `All ${n} doses acknowledged`;
  if (c.dueOrArrived > 0) {
    if (n === 1) return "Today's dose is due now";
    return `${c.dueOrArrived} of ${n} doses ${c.dueOrArrived === 1 ? "is" : "are"} due now`;
  }
  if (c.upcoming > 0) {
    if (n === 1) return "Today's dose is still to come";
    return `${c.upcoming} of ${n} doses still to come`;
  }
  // Only statuses this page does not know: say no more than the total.
  return `${n} ${n === 1 ? "dose" : "doses"} scheduled today`;
}

/** The counts line under the headline, as number and words pairs. Zero counts stay in the list. */
export function countItems(c: DayCounts): { count: number; words: string }[] {
  return [
    { count: c.needsAttention, words: c.needsAttention === 1 ? "needs attention" : "need attention" },
    { count: c.dueOrArrived, words: "due now" },
    { count: c.acknowledged, words: "acknowledged (self-reported)" },
    { count: c.upcoming, words: "upcoming" },
  ];
}

/**
 * Split a dose status line at its first " (": the head is the state ("Needs attention", "Acknowledged 08:20"),
 * the tail the rest starting with "(" ("(self-reported)", "(simulator)"), or "" when there is none.
 * head + " " + tail is the original line whenever the tail is not empty.
 */
export function splitStatusLine(line: string): { head: string; tail: string } {
  const at = line.indexOf(" (");
  if (at < 0) return { head: line, tail: "" };
  return { head: line.slice(0, at), tail: line.slice(at + 1) };
}

/** True for a short machine-like value (a code such as "pilot_took_over"), shown in the data face; sentences are not. */
export function isCodeLike(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 24 && /^[a-z0-9]+(?:[_:-][a-z0-9]+)*$/.test(v);
}
