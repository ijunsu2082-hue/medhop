// Replays __fixtures__/care_store.json (backend/tools/parity_care.py care_store) through store.ts.
//
// Every scenario runs the Python CareStore on a temporary directory; here the same steps run on a
// CareStore over a MemoryStorage with every kind persisted (sessionOnly all false), so what Python
// leaves in its files can be compared with what the port leaves in the storage. After each step the
// result (or the error type and message) must match, and the listing of the stored data must match
// whenever the fixture records one (it records it only when it changed). Numbers in the results are
// trim values, widths and timestamps written as local components: all compared bit for bit.
import { describe, expect, it } from "vitest";
import { assertNoMismatches, BIT_EXACT, compareValues } from "../testing/fixtures";
import { pyRepr } from "../util/num";
import {
  AVOID_MODES,
  CARE_DATA_KINDS,
  CareStore,
  EVENT_TYPES,
  LABEL_MAX,
  NOTES_MAX,
  SEED_DOSES,
  STORAGE_KEYS,
  validateLabel,
  validateNotes,
  validateTime,
  type CareDataKind,
} from "./store";
import { MemoryStorage } from "./storage";
import { fill, listing, loadCareFixture, logicalName, num, outcome, publicOut, tsOf, type Fields } from "./fixtureSupport";

interface StoreStep {
  op: string;
  args?: unknown[];
  at?: Fields;
  start?: Fields;
  end?: Fields;
  name?: keyof typeof STORAGE_KEYS;
  text?: string;
  type?: string;
  count?: number;
  dose_id?: string | null;
  run_id?: string;
  detail?: Record<string, unknown> | null;
  trace?: Record<string, unknown>;
  out: unknown;
  files?: Record<string, unknown>;
}

interface StoreScenario {
  name: string;
  clock: Fields;
  summarize_events: boolean;
  steps: StoreStep[];
}

interface StoreFixture {
  constants: {
    event_types: string[];
    seed_doses: unknown[];
    label_max: number;
    notes_max: number;
    avoid_modes: string[];
  };
  scenarios: StoreScenario[];
}

const fx = loadCareFixture<StoreFixture>("care_store");

const PERSIST_ALL = Object.fromEntries(CARE_DATA_KINDS.map((kind) => [kind, false])) as Record<CareDataKind, boolean>;

class StoreRunner {
  readonly storage = new MemoryStorage();
  now: number;
  store: CareStore | null = null;

  constructor(clock: Fields) {
    this.now = tsOf(clock);
  }

  private get s(): CareStore {
    if (this.store === null) throw new Error("the scenario uses the store before opening it");
    return this.store;
  }

  private key(step: StoreStep): string {
    if (step.name === undefined) throw new Error("a raw step needs a name");
    return STORAGE_KEYS[step.name];
  }

  apply(step: StoreStep): unknown {
    const args = step.args ?? [];
    const s = (): CareStore => this.s;
    switch (step.op) {
      case "clock":
        this.now = tsOf(step.at ?? []);
        return null;
      case "open":
      case "reopen":
        this.store = new CareStore(this.storage, { wallClock: () => this.now, sessionOnly: PERSIST_ALL });
        return null;
      case "write_raw":
        this.storage.setItem(this.key(step), fill(step.text ?? ""));
        return null;
      case "append_raw":
        this.storage.setItem(this.key(step), (this.storage.getItem(this.key(step)) ?? "") + fill(step.text ?? ""));
        return null;
      case "delete_raw":
        this.storage.removeItem(this.key(step));
        return null;
      case "write_event_lines": {
        const base = tsOf(step.at ?? []);
        let text = "";
        for (let i = 0; i < num(step.count); i += 1) {
          text += `{"ts": ${pyRepr(base + i)}, "type": ${JSON.stringify(step.type)}, "dose_id": null, "run_id": null, "detail": {}}\n`;
        }
        this.storage.setItem(STORAGE_KEYS.events, text);
        return null;
      }
      case "validate_time":
        return validateTime(args[0]);
      case "validate_label":
        return validateLabel(args[0]);
      case "validate_notes":
        return validateNotes(args[0]);
      case "list_doses":
        return s().listDoses();
      case "get_dose":
        return s().getDose(String(args[0]));
      case "add_dose":
        return s().addDose(args[0], args[1], ...(args.length > 2 ? [args[2]] : []));
      case "update_dose":
        return s().updateDose(String(args[0]), args[1], args[2], args[3]);
      case "delete_dose":
        return s().deleteDose(String(args[0]));
      case "add_event":
        return publicOut(
          s().addEvent(step.type ?? "", {
            doseId: step.dose_id ?? null,
            runId: step.run_id ?? null,
            detail: step.detail ?? null,
            ts: step.at ? tsOf(step.at) : null,
          }),
        );
      case "events":
        return s()
          .events(...(args.length > 0 ? [num(args[0] === true ? 1 : args[0])] : []))
          .map(publicOut);
      case "events_summary": {
        const got = s().events(...(args.length > 0 ? [num(args[0] === true ? 1 : args[0])] : []));
        return { count: got.length, first: publicOut(got[0]!), last: publicOut(got[got.length - 1]!) };
      }
      case "events_between":
        return s()
          .eventsBetween(tsOf(step.start ?? []), tsOf(step.end ?? []))
          .map(publicOut);
      case "load_trim":
        return s().loadTrim();
      case "save_trim":
        return s().saveTrim(num(args[0]), num(args[1]));
      case "load_arrive_width":
        return s().loadArriveWidth();
      case "save_arrive_width":
        return s().saveArriveWidth(num(args[0]));
      case "load_drift_assist":
        return s().loadDriftAssist();
      case "save_drift_assist":
        return s().saveDriftAssist(args[0] as boolean);
      case "load_land_on_arrival":
        return s().loadLandOnArrival();
      case "save_land_on_arrival":
        return s().saveLandOnArrival(args[0] as boolean);
      case "load_auto_fly":
        return s().loadAutoFly();
      case "save_auto_fly":
        return s().saveAutoFly(args[0] as boolean);
      case "load_avoid":
        return s().loadAvoid();
      case "save_avoid":
        return s().saveAvoid(args[0]);
      case "write_run_trace":
        return logicalName(s().writeRunTrace(step.run_id ?? "", step.trace ?? {}));
      default:
        throw new Error(`unknown store step ${step.op}`);
    }
  }
}

function replay(scenario: StoreScenario): void {
  const runner = new StoreRunner(scenario.clock);
  let expectedFiles: Record<string, unknown> | undefined;
  scenario.steps.forEach((step, i) => {
    const label = `${scenario.name}[${i}] ${step.op}`;
    const out = outcome(() => runner.apply(step));
    assertNoMismatches(compareValues(out, step.out, BIT_EXACT, `${label} out`), label);
    if (step.files !== undefined) expectedFiles = step.files;
    // unchanged since the last recorded listing means: still equal to it
    const files = listing(runner.storage, scenario.summarize_events);
    assertNoMismatches(compareValues(files, expectedFiles ?? {}, BIT_EXACT, `${label} files`), `${label} files`);
  });
}

describe("CareStore against store.py", () => {
  it("has the same constants", () => {
    expect([...EVENT_TYPES]).toEqual(fx.constants.event_types);
    expect(SEED_DOSES.map((d) => ({ ...d }))).toEqual(fx.constants.seed_doses);
    expect(LABEL_MAX).toBe(fx.constants.label_max);
    expect(NOTES_MAX).toBe(fx.constants.notes_max);
    expect([...AVOID_MODES]).toEqual(fx.constants.avoid_modes);
  });

  it("the fixture covers what it claims", () => {
    const steps = fx.scenarios.flatMap((s) => s.steps);
    const messages = new Set(
      steps.map((s) => s.out).filter((o): o is { message: string } => typeof o === "object" && o !== null && "error" in o).map((o) => o.message),
    );
    for (const message of [
      "time must be 24-hour HH:MM",
      "label must not be empty",
      "label must be at most 80 characters",
      "notes must be text",
      "notes must be at most 300 characters",
      "unknown event type 'bogus'",
      "avoid must be one of ('off', 'hold')",
      "'nope'",
    ]) {
      expect(messages.has(message), message).toBe(true);
    }
    const asides = steps.flatMap((s) => Object.keys(s.files ?? {})).filter((name) => name.includes(".corrupt@"));
    expect(new Set(asides.map((name) => name.split(".")[0]))).toEqual(new Set(["schedule", "mission", "trim", "calibration"]));
    // avoid: exactly "off", "hold" and invalid values; never "pass" (its status in the Python is in flux)
    const avoidArgs = steps.filter((s) => s.op === "save_avoid").map((s) => s.args?.[0]);
    expect(avoidArgs).toEqual(expect.arrayContaining(["off", "hold", "sideways"]));
    expect(avoidArgs).not.toContain("pass");
    const storedAvoid = steps.flatMap((s) => {
      const mission = (s.files ?? {})["mission"];
      return typeof mission === "object" && mission !== null && "avoid" in mission ? [(mission as { avoid: unknown }).avoid] : [];
    });
    expect(storedAvoid.length).toBeGreaterThan(0);
    expect(storedAvoid).not.toContain("pass");
    const rawMission = steps.filter((s) => s.op === "write_raw" && s.name === "mission").map((s) => s.text ?? "");
    expect(rawMission.some((text) => text.includes("pass"))).toBe(false);
    expect(steps.filter((s) => s.op === "load_avoid").map((s) => s.out)).not.toContain("pass");
    // one listing summarises a log of more than 500 events
    expect(steps.some((s) => s.op === "events_summary" && (s.out as { count: number }).count === 500)).toBe(true);
  });

  for (const scenario of fx.scenarios) {
    it(`${scenario.name}: ${scenario.steps.length} steps`, () => replay(scenario));
  }
});
