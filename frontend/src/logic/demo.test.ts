// The landing demo's logic, and the whole demo flow against the in-page backend: the calls LandingDemo.tsx makes,
// in its order, on an engine stepped by hand (no animation frames, no timers).

import { describe, expect, it } from "vitest";
import { ApiError, blockersFrom, requestVia } from "../api/client";
import type { DoseToday, Status } from "../api/types";
import { Engine } from "../engine";
import { DEMO } from "../text/landingWording";
import { createTransport } from "../transport/browser";
import {
  GROUND_SETTLE_MS,
  LAND_AGAIN_MS,
  LAND_RETRY_MS,
  demoDose,
  demoLine,
  demoPhase,
  landAction,
  landReply,
  onGround,
  readyToRun,
  startDemoRun,
  stepOf,
  stepStates,
  type DemoCall,
} from "./demo";

const engineFor = (seed = 1) => new Engine({ storage: null, seed, scheduler: null, housekeepingTimer: false });
const callOn = (engine: Engine): DemoCall => {
  const transport = createTransport(engine);
  return (method, path, body) => requestVia(transport, method, path, body, 4000, null);
};
const statusOf = (engine: Engine) => engine.status() as unknown as Status;

describe("steps", () => {
  it("maps each state of a run to a listed step", () => {
    expect(DEMO.steps).toHaveLength(7);
    expect(["countdown", "taking_off", "searching", "approaching", "aligning", "arrived", "landing"].map(stepOf)).toEqual([
      1, 2, 3, 4, 5, 6, 6,
    ]);
    expect(stepOf("idle")).toBeNull();
    expect(stepOf("done")).toBeNull();
    expect(stepOf("constructor")).toBeNull();
  });

  it("marks what is done, what is happening now and what is still to come", () => {
    expect(stepStates(7, "idle", "idle", null)).toEqual(Array(7).fill("todo"));
    expect(stepStates(7, "running", "approaching", 4)).toEqual(["done", "done", "done", "done", "now", "todo", "todo"]);
    // accepted, but the status still shows the last run: the first step is the one happening
    expect(stepStates(7, "running", "done", null)).toEqual(["now", "todo", "todo", "todo", "todo", "todo", "todo"]);
    expect(stepStates(7, "arrived", "done", 6)).toEqual(Array(7).fill("done"));
    expect(stepStates(7, "acknowledged", "done", 6)).toEqual(Array(7).fill("done"));
    // stopped while flying to the sign: that step was not finished
    expect(stepStates(7, "stopped", "aborted", 4)).toEqual(["done", "done", "done", "done", "todo", "todo", "todo"]);
    expect(stepStates(7, "stopped", "aborted", null)).toEqual(Array(7).fill("todo"));
  });
});

describe("landing after Stop", () => {
  const up = { flying: true, grounded: false, groundedFor: 0 };

  it("sends the toggle once, and again only after a refusal", () => {
    expect(landAction({ ...up, sentAt: null, reply: null, now: 0 })).toBe("send");
    expect(landAction({ ...up, sentAt: 100, reply: null, now: 9000 })).toBe("wait");
    // refused (the guard after a takeoff): once more, after a pause
    expect(landAction({ ...up, sentAt: 100, reply: { at: 101, ok: false }, now: 101 + LAND_RETRY_MS - 1 })).toBe("wait");
    expect(landAction({ ...up, sentAt: 100, reply: { at: 101, ok: false }, now: 101 + LAND_RETRY_MS })).toBe("send");
    // a reply from before this press says nothing about it
    expect(landAction({ ...up, sentAt: 100, reply: { at: 50, ok: false }, now: 60_000 })).toBe("wait");
  });

  it("never sends it while the drone is climbing or coming down", () => {
    const moving = { flying: false, grounded: false, groundedFor: 0 };
    expect(landAction({ ...moving, sentAt: null, reply: null, now: 0 })).toBe("wait");
    // accepted and coming down: never again, however long the descent takes
    expect(landAction({ ...moving, sentAt: 100, reply: { at: 101, ok: true }, now: 60_000 })).toBe("wait");
    expect(landAction({ ...moving, sentAt: 100, reply: { at: 101, ok: false }, now: 60_000 })).toBe("wait");
  });

  it("sends it again only when an accepted landing plainly did not happen", () => {
    expect(landAction({ ...up, sentAt: 100, reply: { at: 101, ok: true }, now: 101 + LAND_AGAIN_MS - 1 })).toBe("wait");
    expect(landAction({ ...up, sentAt: 100, reply: { at: 101, ok: true }, now: 101 + LAND_AGAIN_MS })).toBe("send");
  });

  it("is landed only after the drone has stayed on the ground a moment", () => {
    // Right after a takeoff press the drone has not left the ground yet.
    expect(landAction({ flying: false, grounded: true, groundedFor: 0, sentAt: null, reply: null, now: 0 })).toBe("wait");
    expect(landAction({ flying: false, grounded: true, groundedFor: GROUND_SETTLE_MS - 1, sentAt: null, reply: null, now: 0 })).toBe("wait");
    expect(landAction({ flying: false, grounded: true, groundedFor: GROUND_SETTLE_MS, sentAt: null, reply: null, now: 0 })).toBe("landed");
  });

  it("counts a drone as up while it climbs or comes down", () => {
    const pose = { x_m: 0, distance_m: 2, heading_deg: 0 };
    expect(onGround(null)).toBe(true);
    expect(onGround({ ...pose, altitude_m: 0, airborne: false })).toBe(true);
    expect(onGround({ ...pose, altitude_m: 0.4, airborne: false })).toBe(false);
    expect(onGround({ ...pose, altitude_m: 1, airborne: true })).toBe(false);
  });

  it("reads only replies about the takeoff/land toggle", () => {
    expect(landReply(null)).toBeNull();
    expect(landReply({ at: 5, msg: { type: "ack", of: "takeoff_land" } })).toEqual({ at: 5, ok: true });
    expect(landReply({ at: 6, msg: { type: "error", of: "takeoff_land", code: "toggle_guard", message: "x" } })).toEqual({ at: 6, ok: false });
    expect(landReply({ at: 7, msg: { type: "ack", of: "estop" } })).toBeNull();
    expect(landReply({ at: 8, msg: { type: "hello", pilot: true } })).toBeNull();
  });
});

describe("the demo flow on the in-page backend", () => {
  it("runs the loop: a dose comes due, the drone lands at the station, the person acknowledges", async () => {
    const engine = engineFor();
    const call = callOn(engine);
    const pilot = engine.connectPilot();
    expect(pilot).not.toBeNull();
    engine.advance(1);

    expect(demoPhase(statusOf(engine), null, null)).toBe("idle");
    expect(demoLine(statusOf(engine), "idle", null)).toBeNull();

    const run = await startDemoRun(call, "empty", statusOf(engine).care.now_local, DEMO.doseLabel);
    let status = statusOf(engine);
    let dose = demoDose(status, run.doseId);
    expect(dose).toMatchObject({ label: DEMO.doseLabel, status: "due", arrived_at: null });
    expect(status.mission).toMatchObject({ state: "countdown", run_id: run.runId, dose_id: run.doseId, automatic: true });
    expect(demoPhase(status, run.runId, dose)).toBe("running");
    expect(demoLine(status, "running", dose)?.text).toMatch(/^Taking off in \d/);

    const seen = new Set<string>();
    const ended = engine.advanceUntil(() => {
      seen.add(engine.status().mission.state);
      return ["done", "aborted"].includes(engine.status().mission.state);
    }, 90);
    expect(ended).toBe(true);
    for (const state of ["countdown", "taking_off", "approaching", "aligning", "landing"]) expect(seen, state).toContain(state);

    status = statusOf(engine);
    dose = demoDose(status, run.doseId);
    expect(status.mission.state).toBe("done");
    expect(dose?.status).toBe("arrived");
    expect(demoPhase(status, run.runId, dose)).toBe("arrived");
    expect(demoLine(status, "arrived", dose)).toEqual({
      tone: "pass",
      text: `(simulator) The drone reached the station at ${dose!.arrived_at}.`,
    });

    await call("POST", `/api/doses/${run.doseId}/acknowledge`);
    status = statusOf(engine);
    dose = demoDose(status, run.doseId);
    expect(dose?.status).toBe("acknowledged");
    expect(demoPhase(status, run.runId, dose)).toBe("acknowledged");
    expect(demoLine(status, "acknowledged", dose)?.text).toMatch(/^Acknowledged \d\d:\d\d \(self-reported\)\.$/);

    // The drone ends on the ground in front of the sign. For a few seconds a new takeoff would be refused.
    expect(readyToRun(statusOf(engine))).toBe(false);
    expect(engine.advanceUntil(() => readyToRun(statusOf(engine)), 20)).toBe(true);
    const landed = statusOf(engine).sim!.pose!;
    expect(landed.airborne).toBe(false);
    expect(landed.distance_m).toBeGreaterThan(0.28);
    expect(landed.distance_m).toBeLessThan(0.61);

    // Run it again: the drone is back on its start spot, and there is still one demo dose, a new one.
    const again = await startDemoRun(call, "empty", statusOf(engine).care.now_local, DEMO.doseLabel);
    status = statusOf(engine);
    expect(again.doseId).not.toBe(run.doseId);
    expect(again.runId).not.toBe(run.runId);
    expect(status.care.doses.filter((d: DoseToday) => d.label === DEMO.doseLabel).map((d) => d.id)).toEqual([again.doseId]);
    expect(status.sim!.pose!.distance_m).toBeGreaterThan(2);
    expect(status.mission.state).toBe("countdown");
    pilot!.close();
  }, 30_000);

  it("waits for a person who walks across, then carries on to the station", async () => {
    const engine = engineFor(3);
    const call = callOn(engine);
    const pilot = engine.connectPilot();
    engine.advance(1);
    const run = await startDemoRun(call, "crossing", statusOf(engine).care.now_local, DEMO.doseLabel);
    const lines = new Set<string>();
    engine.advanceUntil(() => {
      const status = statusOf(engine);
      const line = demoLine(status, demoPhase(status, run.runId, demoDose(status, run.doseId)), null);
      if (line?.tone === "warn") lines.add(line.text.replace(/[\d.]+ m ahead|closer than about 2.5 m/, "…"));
      return ["done", "aborted"].includes(status.mission.state);
    }, 120);
    const status = statusOf(engine);
    expect(status.mission.state).toBe("done");
    expect([...lines].some((text) => text.startsWith("Waiting: person"))).toBe(true);
    expect(status.mission.avoid?.held_s).toBeGreaterThanOrEqual(1);
    pilot!.close();
  }, 30_000);

  it("refuses to take off with a cart in the lane, says why, and leaves no dose behind", async () => {
    const engine = engineFor();
    const call = callOn(engine);
    const pilot = engine.connectPilot();
    await call("POST", "/api/sim/scenario", { name: "cart" }); // the visitor picks the corridor first
    engine.advance(2);
    const refusal = await startDemoRun(call, "cart", statusOf(engine).care.now_local, DEMO.doseLabel).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(ApiError);
    expect(blockersFrom(refusal)).toEqual(["obstacle_in_view"]);
    const status = statusOf(engine);
    expect(status.care.doses.some((d: DoseToday) => d.label === DEMO.doseLabel)).toBe(false);
    expect(status.mission.state).not.toBe("countdown");
    expect(status.sim!.pose!.airborne).toBe(false);
    pilot!.close();
  });

  it("is refused without the control link, and says so", async () => {
    const engine = engineFor();
    engine.advance(1);
    const refusal = await startDemoRun(callOn(engine), "empty", statusOf(engine).care.now_local, DEMO.doseLabel).catch((e: unknown) => e);
    expect(blockersFrom(refusal)).toContain("no_pilot_link");
  });

  // What the page's effect does on each status: ask landAction, send the toggle when it says so.
  function landFrom(engine: Engine, pilot: NonNullable<ReturnType<Engine["connectPilot"]>>) {
    let sentAt: number | null = null;
    let reply: { at: number; ok: boolean } | null = null;
    let groundedSince: number | null = null;
    let sends = 0;
    const landed = engine.advanceUntil(() => {
      const now = engine.now * 1000;
      const pose = statusOf(engine).sim!.pose!;
      const grounded = onGround(pose);
      groundedSince = grounded ? (groundedSince ?? now) : null;
      const action = landAction({
        flying: pose.airborne,
        grounded,
        groundedFor: grounded ? now - groundedSince! : 0,
        sentAt,
        reply,
        now,
      });
      if (action === "send") {
        sends += 1;
        sentAt = now;
        const message = pilot.receive({ type: "takeoff_land" });
        reply = message ? landReply({ at: now, msg: message as never }) : null;
      }
      return action === "landed";
    }, 40);
    return { landed, sends };
  }

  it("Stop hands the run back, and one toggle lands the drone", async () => {
    const engine = engineFor();
    const call = callOn(engine);
    const pilot = engine.connectPilot()!;
    engine.advance(1);
    const run = await startDemoRun(call, "empty", statusOf(engine).care.now_local, DEMO.doseLabel);
    expect(engine.advanceUntil(() => engine.status().mission.state === "approaching", 40)).toBe(true);

    const answer = await call<{ state: string }>("POST", "/api/mission/abort");
    expect(answer.state).toBe("aborted");
    let status = statusOf(engine);
    const dose = demoDose(status, run.doseId);
    expect(demoPhase(status, run.runId, dose)).toBe("stopped");
    expect(demoLine(status, "stopped", dose, "landing")).toEqual({ tone: "info", text: "Stopped. The simulated drone is landing." });
    expect(status.sim!.pose!.airborne).toBe(true);

    expect(landFrom(engine, pilot)).toEqual({ landed: true, sends: 1 });
    status = statusOf(engine);
    expect(onGround(status.sim!.pose)).toBe(true);
    expect(demoLine(status, "stopped", dose, "landed")?.text).toBe("Stopped.");
    // and the page can run again once the backend's guard after a landing has passed
    expect(engine.advanceUntil(() => readyToRun(statusOf(engine)), 20)).toBe(true);
    pilot.close();
  }, 30_000);

  it("Stop during the climb waits for steady flight, then lands: the drone is never left hovering", async () => {
    const engine = engineFor(2);
    const call = callOn(engine);
    const pilot = engine.connectPilot()!;
    engine.advance(1);
    await startDemoRun(call, "empty", statusOf(engine).care.now_local, DEMO.doseLabel);
    expect(engine.advanceUntil(() => engine.status().mission.state === "taking_off", 20)).toBe(true);
    engine.advance(0.3);
    await call("POST", "/api/mission/abort");

    const { landed, sends } = landFrom(engine, pilot);
    expect(landed).toBe(true);
    expect(sends).toBeGreaterThanOrEqual(1);
    expect(onGround(statusOf(engine).sim!.pose)).toBe(true);
    engine.advance(5);
    expect(onGround(statusOf(engine).sim!.pose)).toBe(true);
    pilot.close();
  }, 30_000);

  it("Stop during the countdown leaves the drone where it is, on the ground", async () => {
    const engine = engineFor();
    const call = callOn(engine);
    const pilot = engine.connectPilot()!;
    engine.advance(1);
    await startDemoRun(call, "empty", statusOf(engine).care.now_local, DEMO.doseLabel);
    engine.advance(2);
    expect(engine.status().mission.state).toBe("countdown");
    await call("POST", "/api/mission/abort");
    expect(landFrom(engine, pilot)).toEqual({ landed: true, sends: 0 });
    pilot.close();
  });
});
