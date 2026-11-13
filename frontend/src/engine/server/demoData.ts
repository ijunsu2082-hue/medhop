// Demo data for the care loop in the browser. Not a port: rules of the browser simulator only.
//
// Python seeds three demo doses (08:00, 13:00, 20:00) on first use. A visitor opening the site at 15:00 would
// be greeted with a morning dose that "needs attention" and a midday one that is late. So here, on first use and
// again on each new local day, the schedule is seeded with only the demo doses still ahead of the visitor's
// clock (all three before 08:00, none after 20:00). The day it was seeded on is kept under DEMO_KEY.
//
// The event log is a JSON-lines string in one storage key and would grow without end: CappedEventsStorage keeps
// only the newest EVENTS_KEEP lines whenever the store writes it.

import type { ScheduleDoseInput } from "../../api/types";
import { formatDate } from "../care/localTime";
import { secondsSinceDoseTime } from "../care/status";
import { CareStore, SEED_DOSES, STORAGE_KEYS, STORAGE_PREFIX } from "../care/store";
import { GuardedStorage, type KeyValueStorage } from "../care/storage";

/** The local day the demo schedule was last seeded on: {"seeded_on": "YYYY-MM-DD"}. */
export const DEMO_KEY = `${STORAGE_PREFIX}demo`;
/** At most this many events are kept in storage (the newest). */
export const EVENTS_KEEP = 500;

/** The demo doses whose time today is still ahead of `now` (local wall clock), in their order. */
export function dosesAhead(now: Date, seeds: readonly ScheduleDoseInput[] = SEED_DOSES): ScheduleDoseInput[] {
  return seeds.filter((dose) => secondsSinceDoseTime(dose, now) < 0).map((dose) => ({ ...dose }));
}

/** The newest `keep` lines of a JSON-lines value (it keeps its trailing newline). */
export function newestLines(text: string, keep: number): string {
  const lines = text.split(/\r\n|\r|\n/).filter((line) => line.trim() !== "");
  if (lines.length <= keep) return text;
  return `${lines.slice(-keep).join("\n")}\n`;
}

/**
 * A KeyValueStorage that passes everything through and keeps only the newest `keep` events in the event log
 * key. Errors of the storage underneath are passed on (the store's GuardedStorage handles them).
 */
export class CappedEventsStorage implements KeyValueStorage {
  constructor(
    private readonly inner: KeyValueStorage,
    private readonly keep: number = EVENTS_KEEP,
    private readonly eventsKey: string = STORAGE_KEYS.events,
  ) {}

  getItem(key: string): string | null {
    return this.inner.getItem(key);
  }

  setItem(key: string, value: string): void {
    this.inner.setItem(key, key === this.eventsKey ? newestLines(value, this.keep) : value);
  }

  removeItem(key: string): void {
    this.inner.removeItem(key);
  }
}

/** The day the demo schedule was seeded on, or null (never, or unreadable). */
export function seededOn(storage: GuardedStorage): string | null {
  const text = storage.getItem(DEMO_KEY);
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (value !== null && typeof value === "object" && typeof (value as { seeded_on?: unknown }).seeded_on === "string") {
      return (value as { seeded_on: string }).seeded_on;
    }
  } catch {
    /* treated as never seeded */
  }
  return null;
}

export function markSeeded(storage: GuardedStorage, now: Date): void {
  storage.setItem(DEMO_KEY, JSON.stringify({ seeded_on: formatDate(now) }));
}

/** Replace the whole schedule with the demo doses still ahead of `now`. Event history is kept. */
export function reseedSchedule(store: CareStore, now: Date): void {
  for (const dose of store.listDoses()) store.deleteDose(dose.id);
  for (const dose of dosesAhead(now)) store.addDose(dose.time, dose.label, dose.notes);
}

/** The persisted keys resetDemoData() clears (the session-only ones go with the in-memory store). */
export const DEMO_DATA_KEYS: readonly string[] = [STORAGE_KEYS.schedule, STORAGE_KEYS.events, STORAGE_KEYS.mission, DEMO_KEY];
