// What the Python store does not have: the key-value storage behind the TypeScript store.
// Persistence through MemoryStorage, session-only kinds, a storage that throws, a full quota and
// corrupt JSON. (Parity with store.py itself is checked by store.test.ts.)
import { afterEach, describe, expect, it } from "vitest";
import { MemoryLogger } from "../util/log";
import { ValueError } from "../util/num";
import { localDate, timestampOf } from "./localTime";
import { careSnapshot } from "./status";
import {
  CareStore,
  DEFAULT_SESSION_ONLY,
  KeyError,
  RUN_TRACE_PREFIX,
  STORAGE_KEYS,
  type CareStoreOptions,
} from "./store";
import { browserStorage, GuardedStorage, MemoryStorage, type KeyValueStorage } from "./storage";

const NOW = timestampOf(localDate(2026, 11, 11, 9, 0, 0));

function options(extra: Partial<CareStoreOptions> = {}): CareStoreOptions {
  return { wallClock: () => NOW, ...extra };
}

/** A storage whose methods throw when told to; counts the calls that reached it. */
class FlakyStorage extends MemoryStorage {
  failGet = false;
  failSet = false;
  failRemove = false;
  /** setItem throws a quota error once the value would be longer than this */
  quota = Infinity;
  writes = 0;

  override getItem(key: string): string | null {
    if (this.failGet) throw new Error("storage is not available");
    return super.getItem(key);
  }

  override setItem(key: string, value: string): void {
    if (this.failSet) throw new Error("storage is not available");
    if (value.length > this.quota) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    this.writes += 1;
    super.setItem(key, value);
  }

  override removeItem(key: string): void {
    if (this.failRemove) throw new Error("storage is not available");
    super.removeItem(key);
  }
}

describe("persistence through a KeyValueStorage", () => {
  it("round-trips the schedule, the event log and the mission settings", () => {
    const storage = new MemoryStorage();
    const first = new CareStore(storage, options());
    const added = first.addDose("09:30", "Extra dose (demo)", "with water");
    first.updateDose("d1", "07:45");
    expect(first.deleteDose("d2")).toBe(true);
    first.addEvent("pickup_acknowledged", { doseId: "d1", ts: NOW - 60, detail: { self_reported: true } });
    first.saveAutoFly(true);
    first.saveAvoid("hold");

    const again = new CareStore(storage, options());
    expect(again.listDoses()).toEqual(first.listDoses());
    expect(again.getDose(added.id)).toEqual(added);
    expect(again.events()).toEqual(first.events());
    expect([again.loadAutoFly(), again.loadAvoid(), again.loadDriftAssist()]).toEqual([true, "hold", false]);
    expect(storage.keys().sort()).toEqual([STORAGE_KEYS.events, STORAGE_KEYS.mission, STORAGE_KEYS.schedule]);
    expect(storage.keys().every((key) => key.startsWith("medhop.v1."))).toBe(true);
  });

  it("two tabs on one storage never hand out the same dose id", () => {
    // Each tab is a store of its own, loaded before the other one wrote anything.
    const storage = new MemoryStorage();
    const tabA = new CareStore(storage, options());
    const tabB = new CareStore(storage, options());
    const fromA = tabA.addDose("09:30", "Demo dose", "");
    tabA.addEvent("arrived_at_station", { doseId: fromA.id, ts: NOW - 30, detail: { mode: "sim" } });
    const fromB = tabB.addDose("09:31", "Demo dose", "");
    expect(fromB.id).not.toBe(fromA.id);
    // ... also after the other tab's dose is gone from the schedule: its events are still in the log.
    tabA.deleteDose(fromA.id);
    const laterB = tabB.addDose("09:32", "Demo dose", "");
    const laterA = tabA.addDose("09:33", "Demo dose", "");
    expect(new Set([fromA.id, fromB.id, laterB.id, laterA.id]).size).toBe(4);
  });

  it("stores the formats of the Python files", () => {
    const storage = new MemoryStorage();
    const store = new CareStore(storage, options());
    store.addEvent("hover_test", { ts: NOW, detail: { pass: true } });
    store.addEvent("reminder_due", { doseId: "d1", ts: NOW + 1 });
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.schedule) ?? "")).toEqual({
      doses: [
        { id: "d1", time: "08:00", label: "Morning dose (demo)", notes: "" },
        { id: "d2", time: "13:00", label: "Midday dose (demo)", notes: "" },
        { id: "d3", time: "20:00", label: "Evening dose (demo)", notes: "" },
      ],
      next_id: 4,
    });
    const lines = (storage.getItem(STORAGE_KEYS.events) ?? "").split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe("");
    expect(JSON.parse(lines[1] ?? "")).toEqual({ ts: NOW + 1, type: "reminder_due", dose_id: "d1", run_id: null, detail: {} });
  });

  it("feeds care_snapshot after a reload", () => {
    const storage = new MemoryStorage();
    new CareStore(storage, options()).addEvent("arrived_at_station", { doseId: "d1", ts: NOW - 3600, detail: { mode: "sim" } });
    const snapshot = careSnapshot(new CareStore(storage, options()), localDate(2026, 11, 11, 8, 5), 15);
    expect(snapshot.doses[0]).toMatchObject({ id: "d1", status: "arrived", arrived_at: "08:00", arrived_mode: "sim" });
  });

  it("works without any storage", () => {
    const store = new CareStore(null, options());
    expect(store.listDoses()).toHaveLength(3);
    store.addDose("10:00", "Memory only (demo)");
    store.saveLandOnArrival(true);
    expect(store.loadLandOnArrival()).toBe(true);
    expect(store.listDoses()).toHaveLength(4);
  });

  it("takes the seed doses as a parameter and validates them", () => {
    const store = new CareStore(new MemoryStorage(), options({ seedDoses: [{ time: " 06:30 ", label: " Early (demo) ", notes: "" }] }));
    expect(store.listDoses()).toEqual([{ id: "d1", time: "06:30", label: "Early (demo)", notes: "" }]);
    expect(store.addDose("07:00", "Next (demo)").id).toBe("d2");
    expect(new CareStore(new MemoryStorage(), options({ seedDoses: [] })).listDoses()).toEqual([]);
    expect(() => new CareStore(new MemoryStorage(), options({ seedDoses: [{ time: "25:00", label: "x", notes: "" }] }))).toThrow(
      ValueError,
    );
  });

  it("uses the injected wall clock", () => {
    let now = NOW;
    const store = new CareStore(new MemoryStorage(), { wallClock: () => now });
    expect(store.addEvent("hover_test").ts).toBe(NOW);
    now += 0.5;
    expect(store.addEvent("hover_test").ts).toBe(NOW + 0.5);
  });

  it("raises the Python error types", () => {
    const store = new CareStore(new MemoryStorage(), options());
    expect(() => store.addDose("8:00", "x")).toThrow(new ValueError("time must be 24-hour HH:MM"));
    expect(() => store.updateDose("nope", null, "x")).toThrow(KeyError);
    try {
      store.updateDose("nope", null, "x");
    } catch (error) {
      expect(error).toBeInstanceOf(KeyError);
      expect((error as KeyError).key).toBe("nope");
      expect((error as KeyError).message).toBe("'nope'");
    }
    expect(() => store.saveAvoid("pass")).toThrow("avoid must be one of ('off', 'hold')");
    expect(() => store.addEvent("bogus")).toThrow("unknown event type 'bogus'");
    expect(() => store.events(Number.NaN)).toThrow(ValueError);
  });
});

describe("session-only kinds", () => {
  it("defaults: schedule, events and mission persist; trim, calibration and run traces do not", () => {
    expect(DEFAULT_SESSION_ONLY).toEqual({
      schedule: false,
      events: false,
      mission: false,
      trim: true,
      calibration: true,
      runs: true,
    });
  });

  it("are kept in memory and never written", () => {
    const storage = new FlakyStorage();
    const store = new CareStore(storage, options());
    const writes = storage.writes;
    store.saveTrim(0.02, -0.01);
    store.saveArriveWidth(0.21);
    const key = store.writeRunTrace("run-x", { run_id: "run-x", samples: [] });
    expect(storage.writes).toBe(writes);
    expect(storage.keys().sort()).toEqual([STORAGE_KEYS.schedule]);
    expect(key).toBe(`${RUN_TRACE_PREFIX}run-x`);
    expect(store.loadTrim()).toEqual([0.02, -0.01]);
    expect(store.loadArriveWidth()).toBe(0.21);
    expect(store.readRunTrace("run-x")).toEqual({ run_id: "run-x", samples: [] });
    expect(store.isSessionOnly("trim")).toBe(true);

    const nextVisit = new CareStore(storage, options());
    expect(nextVisit.loadTrim()).toEqual([0.0, 0.0]);
    expect(nextVisit.loadArriveWidth()).toBeNull();
    expect(nextVisit.readRunTrace("run-x")).toBeNull();
  });

  it("never read a stored value, so a bad one can not break a later visit", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEYS.trim, '{"roll": 9, "pitch": 9}');
    storage.setItem(STORAGE_KEYS.calibration, "{corrupt");
    const store = new CareStore(storage, options());
    expect(store.loadTrim()).toEqual([0.0, 0.0]);
    expect(store.loadArriveWidth()).toBeNull();
    // left exactly as it was: not read, not set aside, not removed
    expect(storage.getItem(STORAGE_KEYS.trim)).toBe('{"roll": 9, "pitch": 9}');
    expect(storage.getItem(STORAGE_KEYS.calibration)).toBe("{corrupt");
    expect(storage.keys().filter((k) => k.includes(".corrupt-"))).toEqual([]);
  });

  it("can be chosen per kind in the constructor", () => {
    const storage = new MemoryStorage();
    const store = new CareStore(storage, options({ sessionOnly: { events: true, schedule: true, trim: false } }));
    store.addDose("10:00", "Session only (demo)");
    store.addEvent("hover_test", { ts: NOW });
    store.saveTrim(0.01, 0.02);
    store.saveDriftAssist(true);
    expect(storage.keys().sort()).toEqual([STORAGE_KEYS.mission, STORAGE_KEYS.trim]);
    const again = new CareStore(storage, options({ sessionOnly: { events: true, schedule: true, trim: false } }));
    expect(again.loadTrim()).toEqual([0.01, 0.02]);
    expect(again.listDoses()).toHaveLength(3);
    expect(again.events(500)).toEqual([]);
    expect(again.loadDriftAssist()).toBe(true);
  });
});

describe("a storage that fails", () => {
  it("throwing on every call: the store opens and works in memory", () => {
    const storage = new FlakyStorage();
    storage.failGet = storage.failSet = storage.failRemove = true;
    const logger = new MemoryLogger();
    const store = new CareStore(storage, options({ logger }));
    expect(store.listDoses().map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    store.addDose("10:00", "Still works (demo)");
    store.deleteDose("d1");
    store.addEvent("pickup_acknowledged", { doseId: "d2", ts: NOW });
    store.addEvent("hover_test", { ts: NOW + 1 });
    store.saveAvoid("hold");
    store.saveLandOnArrival(true);
    expect(store.listDoses().map((d) => d.id)).toEqual(["d4", "d2", "d3"]);
    expect(store.events().map((e) => e.type)).toEqual(["hover_test", "pickup_acknowledged"]);
    expect([store.loadAvoid(), store.loadLandOnArrival()]).toEqual(["hold", true]);
    expect(storage.size).toBe(0);
    const warnings = logger.entries.filter(([level]) => level === "warning");
    // one warning per key, not one per call
    expect(warnings.length).toBe(3);
    expect(warnings.every(([, message]) => message.includes("keeping it in memory"))).toBe(true);
  });

  it("throwing on reads only: the data starts afresh in memory", () => {
    const storage = new FlakyStorage();
    new CareStore(storage, options()).addDose("10:00", "Stored before (demo)");
    storage.failGet = true;
    const store = new CareStore(storage, options());
    expect(store.listDoses()).toHaveLength(3);
    store.addDose("11:00", "In memory (demo)");
    storage.failGet = false;
    // the stored schedule was never overwritten
    expect(new CareStore(storage, options()).listDoses().map((d) => d.label)).toContain("Stored before (demo)");
  });

  it("a full quota: the key that does not fit stays in memory, the others keep persisting", () => {
    const storage = new FlakyStorage();
    storage.quota = 600;
    const logger = new MemoryLogger();
    const store = new CareStore(storage, options({ logger }));
    for (let i = 0; i < 8; i += 1) store.addEvent("hover_test", { ts: NOW + i, detail: { i } });
    const storedEvents = storage.getItem(STORAGE_KEYS.events) ?? "";
    expect(storedEvents.length).toBeLessThanOrEqual(600);
    expect(storedEvents.split("\n").length - 1).toBeLessThan(8);
    // this session still sees every event, and keeps adding to memory
    expect(store.events(50)).toHaveLength(8);
    store.addEvent("hover_test", { ts: NOW + 8 });
    expect(store.events(50)).toHaveLength(9);
    // the schedule key still persists
    store.addDose("10:00", "Persisted (demo)");
    expect(new CareStore(storage, options()).listDoses().map((d) => d.label)).toContain("Persisted (demo)");
    // the next visit reads what was stored before the quota ran out
    expect(new CareStore(storage, options()).events(50).length).toBe(storedEvents.split("\n").length - 1);
    const quota = logger.entries.filter(([, message]) => message.includes("QuotaExceededError"));
    expect(quota).toHaveLength(1);
  });

  it("GuardedStorage serves only the failed key from memory", () => {
    const storage = new FlakyStorage();
    const guarded = new GuardedStorage(storage);
    storage.quota = 5;
    guarded.setItem("big", "too long");
    guarded.setItem("ok", "fits");
    expect([guarded.getItem("big"), guarded.getItem("ok")]).toEqual(["too long", "fits"]);
    expect([storage.getItem("big"), storage.getItem("ok")]).toEqual([null, "fits"]);
    expect([guarded.inMemory("big"), guarded.inMemory("ok")]).toEqual([true, false]);
    guarded.removeItem("big");
    expect(guarded.getItem("big")).toBeNull();
    expect(guarded.trySetItem("other", "too long")).toBe(false);
    expect(new GuardedStorage(null).trySetItem("x", "y")).toBe(false);
  });
});

describe("corrupt JSON", () => {
  it("a corrupt schedule is set aside and the demo doses are seeded", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEYS.schedule, "{not json");
    const store = new CareStore(storage, options());
    expect(store.listDoses()).toHaveLength(3);
    expect(storage.getItem(`${STORAGE_KEYS.schedule}.corrupt-${Math.trunc(NOW)}`)).toBe("{not json");
  });

  it("corrupt mission settings fall back to the defaults and are set aside", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEYS.mission, "{oops");
    const store = new CareStore(storage, options());
    expect([store.loadDriftAssist(), store.loadAvoid()]).toEqual([false, null]);
    expect(storage.getItem(STORAGE_KEYS.mission)).toBeNull();
    store.saveAutoFly(true);
    expect(JSON.parse(storage.getItem(STORAGE_KEYS.mission) ?? "")).toEqual({ auto_fly: true });
  });

  it("unreadable event lines are skipped, one line at a time", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEYS.events, `garbage\n{"ts": ${NOW}, "type": "hover_test"}\n{"ts": 1, "type": "run_sta`);
    const store = new CareStore(storage, options());
    expect(store.events().map((e) => e.type)).toEqual(["hover_test"]);
    store.addEvent("reminder_due", { doseId: "d1", ts: NOW + 1 });
    // started on a fresh line, after the truncated one
    expect(storage.getItem(STORAGE_KEYS.events)?.endsWith(`"run_sta\n{"ts":${NOW + 1},"type":"reminder_due","dose_id":"d1","run_id":null,"detail":{}}\n`)).toBe(true);
    expect(new CareStore(storage, options()).events().map((e) => e.type)).toEqual(["reminder_due", "hover_test"]);
  });

  it("when setting a value aside fails, the value is left in place, as Python leaves the file", () => {
    const storage = new FlakyStorage();
    storage.setItem(STORAGE_KEYS.mission, "{oops");
    storage.quota = 3;
    const logger = new MemoryLogger();
    const store = new CareStore(storage, options({ logger }));
    expect(store.loadAutoFly()).toBe(false);
    expect(storage.getItem(STORAGE_KEYS.mission)).toBe("{oops");
    expect(logger.entries.some(([level, message]) => level === "error" && message.includes("could not move"))).toBe(true);
  });
});

describe("deliberate differences from the Python (documented in store.ts)", () => {
  it("a non-finite trim is written as JSON null and reads back as the default", () => {
    const store = new CareStore(new MemoryStorage(), options({ sessionOnly: { trim: false } }));
    store.saveTrim(Number.NaN, 0.1);
    expect(store.loadTrim()).toEqual([0.0, 0.0]);
  });

  it("an event line with a dose_id that is not a string loads with null", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEYS.events, `{"ts": ${NOW}, "type": "arrived_at_station", "dose_id": ["d1"], "run_id": 5}\n`);
    const event = new CareStore(storage, options()).events()[0];
    expect([event?.dose_id, event?.run_id]).toEqual([null, null]);
  });

  it("an infinite next_id counts as invalid (Python fails to open the store)", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEYS.schedule, '{"doses": [], "next_id": 1e400}');
    expect(new CareStore(storage, options()).addDose("08:00", "x").id).toBe("d1");
  });
});

describe("browserStorage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("is null where there is no localStorage, or touching it throws", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(browserStorage()).toBeNull();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(browserStorage()).toBeNull();
  });

  it("returns localStorage where there is one", () => {
    const fake: KeyValueStorage = new MemoryStorage();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: fake });
    expect(browserStorage()).toBe(fake);
  });
});
