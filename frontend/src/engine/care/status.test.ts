// Replays __fixtures__/care_status.json (backend/tools/parity_care.py care_status) through status.ts.
//
// "pure": dose_statuses, next_due_id, time_has_come and day_bounds on scripted and random situations.
// "runs": care_snapshot and CareMonitor.tick on a real store, with doses added, edited and deleted
// during the day, the store reopened, and clocks running across midnight, a month and a year.
// Every time in the fixture is in local components, so the suite passes in any time zone. All values
// are strings, booleans, integers or null except `grace_min` (0.5 in one case), so the comparison is exact.
import { describe, expect, it } from "vitest";
import { assertNoMismatches, BIT_EXACT, compareValues } from "../testing/fixtures";
import { naiveMs, timestampOf } from "./localTime";
import {
  ACKNOWLEDGED,
  ARRIVED,
  CareMonitor,
  careSnapshot,
  dayBounds,
  DUE,
  doseStatuses,
  doseTimeToday,
  NEEDS_ATTENTION,
  nextDueId,
  PENDING,
  secondsSinceDoseTime,
  STATUSES,
  timeHasCome,
  UPCOMING,
  type DoseLike,
  type StatusEvent,
} from "./status";
import { CareStore } from "./store";
import { MemoryStorage } from "./storage";
import { addSeconds, fieldsOf, loadCareFixture, num, outcome, publicOut, toDate, tsOf, type Fields } from "./fixtureSupport";

interface FixtureEvent {
  type: string;
  dose_id: string | null;
  run_id: string | null;
  at: Fields;
  detail?: unknown;
}

interface PureCase {
  name: string;
  doses: DoseLike[];
  events: FixtureEvent[];
  now: Fields;
  grace_min: number;
  out: { statuses: unknown[]; next_due_id: string | null; time_has_come: boolean[]; day_bounds: Fields[] };
}

interface RunStep {
  op: string;
  at?: Fields;
  from?: Fields;
  to?: Fields;
  every_s?: number;
  args?: unknown[];
  type?: string;
  dose_id?: string | null;
  run_id?: string | null;
  detail?: Record<string, unknown> | null;
  out: unknown;
}

interface StatusRun {
  name: string;
  grace_min: number;
  steps: RunStep[];
}

interface StatusFixture {
  constants: {
    statuses: string[];
    pending: string[];
    upcoming: string;
    due: string;
    arrived: string;
    acknowledged: string;
    needs_attention: string;
  };
  pure: PureCase[];
  runs: StatusRun[];
}

const fx = loadCareFixture<StatusFixture>("care_status");

function eventsOf(events: FixtureEvent[]): StatusEvent[] {
  return events.map((e) => {
    const event: StatusEvent & { run_id: string | null } = { ts: tsOf(e.at), type: e.type, dose_id: e.dose_id, run_id: e.run_id };
    if (Object.prototype.hasOwnProperty.call(e, "detail")) event.detail = e.detail;
    return event;
  });
}

function replayPure(c: PureCase): void {
  const now = toDate(c.now);
  const statuses = doseStatuses(c.doses, eventsOf(c.events), now, c.grace_min);
  const [start, end] = dayBounds(now);
  const actual = {
    statuses,
    next_due_id: nextDueId(statuses, now),
    time_has_come: statuses.map((d) => timeHasCome(d, now)),
    day_bounds: [fieldsOf(start), fieldsOf(end)],
  };
  assertNoMismatches(compareValues(actual, c.out, BIT_EXACT, c.name), c.name);
}

class StatusRunner {
  readonly storage = new MemoryStorage();
  now: number;
  store: CareStore;
  monitor: CareMonitor;

  constructor(
    clock: Fields,
    readonly grace: number,
  ) {
    this.now = tsOf(clock);
    this.store = this.open();
    this.monitor = new CareMonitor(this.store, grace);
  }

  open(): CareStore {
    return new CareStore(this.storage, { wallClock: () => this.now });
  }

  apply(step: RunStep): unknown {
    if (step.at) this.now = tsOf(step.at);
    const args = step.args ?? [];
    switch (step.op) {
      case "reopen":
        this.store = this.open();
        this.monitor = new CareMonitor(this.store, this.grace);
        return null;
      case "add_dose":
        return this.store.addDose(args[0], args[1], ...(args.length > 2 ? [args[2]] : []));
      case "update_dose":
        return this.store.updateDose(String(args[0]), args[1], args[2], args[3]);
      case "delete_dose":
        return this.store.deleteDose(String(args[0]));
      case "event":
        return publicOut(
          this.store.addEvent(step.type ?? "", {
            doseId: step.dose_id ?? null,
            runId: step.run_id ?? null,
            detail: step.detail ?? null,
            ts: tsOf(step.at ?? []),
          }),
        );
      case "snapshot":
        return careSnapshot(this.store, toDate(step.at ?? []), this.grace);
      case "tick":
        return this.monitor.tick(toDate(step.at ?? [])).map(publicOut);
      case "ticks": {
        const from = step.from ?? [];
        const end = naiveMs(toDate(step.to ?? []));
        const every = num(step.every_s);
        const out: unknown[] = [];
        let k = 0;
        let moment = toDate(from);
        while (naiveMs(moment) <= end) {
          const written = this.monitor.tick(moment);
          if (written.length > 0) out.push([k, written.map(publicOut)]);
          k += 1;
          moment = addSeconds(from, every * k);
        }
        this.now = timestampOf(moment);
        return out;
      }
      default:
        throw new Error(`unknown status step ${step.op}`);
    }
  }
}

function replayRun(run: StatusRun): void {
  const first = run.steps.find((s) => s.at ?? s.from);
  const runner = new StatusRunner(first?.at ?? first?.from ?? [2026, 11, 11], run.grace_min);
  run.steps.forEach((step, i) => {
    const label = `${run.name}[${i}] ${step.op}`;
    const out = outcome(() => runner.apply(step));
    assertNoMismatches(compareValues(out, step.out, BIT_EXACT, label), label);
  });
}

describe("care status against status.py", () => {
  it("has the same constants", () => {
    expect([...STATUSES]).toEqual(fx.constants.statuses);
    expect([...PENDING]).toEqual(fx.constants.pending);
    expect([UPCOMING, DUE, ARRIVED, ACKNOWLEDGED, NEEDS_ATTENTION]).toEqual([
      fx.constants.upcoming,
      fx.constants.due,
      fx.constants.arrived,
      fx.constants.acknowledged,
      fx.constants.needs_attention,
    ]);
  });

  it("the fixture covers what it claims", () => {
    const statuses = new Set(fx.pure.flatMap((c) => c.out.statuses.map((s) => (s as { status: string }).status)));
    expect(statuses).toEqual(new Set(STATUSES));
    const modes = new Set(fx.pure.flatMap((c) => c.out.statuses.map((s) => (s as { arrived_mode: unknown }).arrived_mode)));
    expect(modes).toEqual(new Set(["sim", "real", null]));
    expect(new Set(fx.pure.map((c) => c.out.next_due_id === null))).toEqual(new Set([true, false]));
    const written = fx.runs.flatMap((r) =>
      r.steps.flatMap((s) => {
        if (s.op === "tick") return s.out as { type: string }[];
        if (s.op === "ticks") return (s.out as [number, { type: string }[]][]).flatMap(([, events]) => events);
        return [];
      }),
    );
    expect(new Set(written.map((e) => e.type))).toEqual(new Set(["reminder_due", "needs_attention"]));
    const dates = new Set(
      fx.runs.flatMap((r) => r.steps.filter((s) => s.op === "snapshot").map((s) => (s.out as { date_local: string }).date_local)),
    );
    for (const date of ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-30", "2026-12-01", "2026-12-31", "2027-01-01"]) {
      expect(dates.has(date), date).toBe(true);
    }
    const ops = new Set(fx.runs.flatMap((r) => r.steps.map((s) => s.op)));
    expect(ops).toEqual(new Set(["ticks", "tick", "snapshot", "event", "add_dose", "update_dose", "delete_dose", "reopen"]));
  });

  for (const c of fx.pure) {
    it(`pure: ${c.name}`, () => replayPure(c));
  }

  for (const run of fx.runs) {
    it(`run: ${run.name} (${run.steps.length} steps)`, () => replayRun(run));
  }

  it("dose times and lateness use wall-clock fields", () => {
    const now = toDate([2026, 11, 11, 8, 1, 30]);
    const at = doseTimeToday({ time: "08:00" }, now);
    expect([at.getHours(), at.getMinutes(), at.getSeconds(), at.getDate()]).toEqual([8, 0, 0, 11]);
    expect(secondsSinceDoseTime({ time: "08:00" }, now)).toBe(90);
    expect(secondsSinceDoseTime({ time: "09:00" }, now)).toBe(-3510);
  });
});
