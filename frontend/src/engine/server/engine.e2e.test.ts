// End to end through the engine's own API, in virtual time with advance(): automatic runs in each corridor
// scenario, and the care loop's automatic flight for a dose that comes due.

import { describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { localDate, timestampOf } from "../care/localTime";
import { MemoryStorage } from "../care/storage";

const FINISHED = new Set(["done", "aborted"]);

function engineAt(wall: () => number, seed = 3, storage: MemoryStorage | null = null): Engine {
  return new Engine({ storage, wallClock: wall, seed, scheduler: null, housekeepingTimer: false });
}

/** A fixed local morning (07:00 on a weekday), so the demo doses are all still ahead. */
function morning(): { wall: () => number; set: (d: Date) => void } {
  let ts = timestampOf(localDate(2026, 11, 12, 7, 0, 0));
  return { wall: () => ts, set: (d: Date) => (ts = timestampOf(d)) };
}

function mission(engine: Engine) {
  return engine.status().mission;
}

interface RunResult {
  state: string;
  reason: string | null;
  seen: Set<string>;
  avoidStates: Set<string>;
  simSeconds: number;
}

function automaticRun(engine: Engine, scenario: string, limitS = 120): RunResult {
  engine.advance(1.0);
  expect(engine.request("POST", "/api/sim/scenario", { name: scenario }).status).toBe(200);
  engine.advance(0.5);
  const started = engine.request("POST", "/api/mission/start", { automatic: true, dose_id: null });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const t0 = engine.now;
  const seen = new Set<string>();
  const avoidStates = new Set<string>();
  let steps = 0;
  engine.advanceUntil(() => {
    steps += 1;
    if (steps % 12 === 0) {
      // the status as a page sees it, five times a second
      const m = mission(engine);
      seen.add(m.state);
      if (m.avoid.state) avoidStates.add(m.avoid.state);
    }
    return FINISHED.has(engine.core.runner.state);
  }, limitS);
  const m = mission(engine);
  return { state: m.state, reason: m.reason, seen, avoidStates, simSeconds: engine.now - t0 };
}

describe("automatic runs through the engine (simulator)", () => {
  it("an empty corridor ends done, landed at the sign", () => {
    const clock = morning();
    const engine = engineAt(clock.wall, 3);
    const pilot = engine.connectPilot();
    expect(pilot).not.toBeNull();
    const run = automaticRun(engine, "empty");
    expect([run.state, run.reason], JSON.stringify([...run.seen])).toEqual(["done", null]);
    expect([...run.seen]).toEqual(expect.arrayContaining(["countdown", "taking_off", "approaching"]));
    engine.advance(3);
    const status = engine.status();
    expect(status.sim?.pose.airborne).toBe(false);
    expect(status.sim?.pose.distance_m).toBeLessThan(0.7);
    const events = engine.request("GET", "/api/events?limit=5").body as { events: { type: string }[] };
    expect(events.events.map((e) => e.type).slice(0, 2)).toEqual(["arrived_at_station", "run_started"]);
  });

  it("with a person crossing it holds on the way, then still ends done", () => {
    const clock = morning();
    const engine = engineAt(clock.wall, 3);
    engine.connectPilot();
    const run = automaticRun(engine, "crossing");
    expect(run.avoidStates.has("hold"), JSON.stringify([...run.avoidStates])).toBe(true);
    expect([run.state, run.reason]).toEqual(["done", null]);
  });

  it("with a person standing in the lane it ends path_blocked", () => {
    const clock = morning();
    const engine = engineAt(clock.wall, 3);
    engine.connectPilot();
    const run = automaticRun(engine, "standing");
    expect([run.state, run.reason]).toEqual(["aborted", "path_blocked"]);
  });

  it("with a cart in the lane the start is refused with obstacle_in_view", () => {
    const clock = morning();
    const engine = engineAt(clock.wall, 3);
    engine.connectPilot();
    engine.advance(1.0);
    expect(engine.request("POST", "/api/sim/scenario", { name: "cart" }).status).toBe(200);
    engine.advance(1.0);
    const refused = engine.request("POST", "/api/mission/start", { automatic: true, dose_id: null });
    expect(refused.status).toBe(409);
    expect((refused.body as { blockers: string[] }).blockers).toContain("obstacle_in_view");
    expect(mission(engine).run_id).toBeNull();
  });
});

describe("a dose that comes due", () => {
  it("starts an automatic flight when automatic flights are on and the drone was marked ready", () => {
    const clock = morning();
    const storage = new MemoryStorage();
    const engine = engineAt(clock.wall, 5, storage);
    engine.connectPilot();
    engine.advance(1.0);
    const dose = engine.request("POST", "/api/schedule", { time: "07:02", label: "Test dose (demo)" }).body as { id: string };
    expect(engine.request("PUT", "/api/mission/settings", { auto_fly: true }).status).toBe(200);
    expect(engine.request("POST", "/api/mission/ready").body).toEqual({ ok: true, ready_for_dose: true });
    engine.housekeeping();
    expect(mission(engine).state).toBe("idle"); // not due yet
    clock.set(localDate(2026, 11, 12, 7, 2, 1));
    engine.housekeeping();
    expect(mission(engine)).toMatchObject({ state: "countdown", automatic: true, dose_id: dose.id });
    engine.advanceUntil(() => FINISHED.has(engine.core.runner.state), 120);
    expect([mission(engine).state, mission(engine).reason]).toEqual(["done", null]);
    clock.set(localDate(2026, 11, 12, 7, 3, 30));
    const care = engine.status().care;
    const row = care.doses.find((d) => d.id === dose.id)!;
    expect(row.status).toBe("arrived");
    expect(row.arrived_mode).toBe("sim");
    expect(row.arrived_at).toMatch(/^07:0\d$/);

    // acknowledging it shows in the caregiver's data: the dose row and the event list
    const ack = engine.request("POST", `/api/doses/${dose.id}/acknowledge`);
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ ok: true, dose_id: dose.id, already_acknowledged: false });
    expect(engine.status().care.doses.find((d) => d.id === dose.id)!.status).toBe("acknowledged");
    const events = (engine.request("GET", "/api/events?limit=10").body as { events: { type: string; dose_id: string | null; detail: unknown }[] }).events;
    expect(events[0]).toMatchObject({ type: "pickup_acknowledged", dose_id: dose.id, detail: { self_reported: true } });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["reminder_due", "run_started", "arrived_at_station"]));
  });

  it("logs auto_run_skipped (not_ready) when nobody marked the drone ready", () => {
    const clock = morning();
    const engine = engineAt(clock.wall, 5);
    engine.connectPilot();
    engine.advance(1.0);
    const dose = engine.request("POST", "/api/schedule", { time: "07:02", label: "Test dose (demo)" }).body as { id: string };
    engine.request("PUT", "/api/mission/settings", { auto_fly: true });
    clock.set(localDate(2026, 11, 12, 7, 2, 1));
    engine.housekeeping();
    expect(mission(engine).state).toBe("idle");
    const events = (engine.request("GET", "/api/events?limit=2").body as { events: { type: string; dose_id: string; detail: unknown }[] }).events;
    expect(events[0]).toMatchObject({ type: "auto_run_skipped", dose_id: dose.id, detail: { blockers: ["not_ready"] } });
  });
});
