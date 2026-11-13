// The engine's status document (key sets pinned from the Python tests), its control channel, speed, the
// demo-data rules (seeding only the doses still ahead, the 500-event cap) and storage that fails.

import { describe, expect, it } from "vitest";
import { Engine } from "../engine";
import { localDate, timestampOf } from "../care/localTime";
import { MemoryStorage, type KeyValueStorage } from "../care/storage";
import { STORAGE_KEYS } from "../care/store";
import { DEMO_KEY, dosesAhead, EVENTS_KEEP } from "./demoData";

// Copied from backend/tests/test_api.py (TOP_KEYS ... SIM_POSE_KEYS) and backend/tests/test_avoid_api.py
// (AVOID_KEYS, OBSTACLE_KEYS, ACTOR_KEYS).
const TOP_KEYS = ["server_time", "mode", "link", "telemetry", "trim", "pilot", "vision", "mission", "hover_test", "care", "sim"];
const LINK_KEYS = ["video_live", "frame_age_s", "fps", "control_up", "drone_seen", "sticks_blocked"];
const TELEMETRY_KEYS = ["simulated", "age_s", "fly_state_raw", "battery_raw", "flags_raw", "battery_low", "battery_check_enabled"];
const TRIM_KEYS = ["roll", "pitch"];
const PILOT_KEYS = ["manual_active", "max_stick", "estop_active", "estop_delivered"];
const VISION_KEYS = ["marker", "person", "brightness", "dark", "obstacles"];
const MARKER_KEYS = ["id", "cx", "cy", "width", "age_s"];
const PERSON_KEYS = ["enabled", "detected", "count", "age_s"];
const MISSION_KEYS = [
  "state", "reason", "run_id", "dose_id", "elapsed_s", "command", "arrive_width", "land_on_arrival", "drift_assist",
  "can_start", "blockers", "last_landing", "automatic", "auto_fly", "auto_blockers", "can_start_auto",
  "countdown_remaining_s", "distance_m", "arrive_distance_m", "flight_confirmed", "needs_pilot", "ready_for_dose",
  "alignment", "last_arrival", "avoid",
];
const COMMAND_KEYS = ["yaw", "pitch"];
const DRIFT_ASSIST_KEYS = ["enabled", "active", "roll", "disabled_reason", "suggested_trim_roll"];
const HOVER_KEYS = ["running", "elapsed_s", "result"];
const CARE_KEYS = ["now_local", "date_local", "doses", "next_due_id"];
const DOSE_STATUS_KEYS = ["id", "time", "label", "notes", "status", "arrived_at", "acknowledged_at", "arrived_mode"];
const AVOID_KEYS = ["mode", "state", "kind", "distance_m", "held_s"];
const OBSTACLE_KEYS = ["kind", "box", "distance_m", "lateral_m", "in_lane"];
const ACTOR_KEYS = ["kind", "x_m", "distance_m", "width_m", "depth_m", "height_m"];
const SIM_KEYS = ["scenario", "actors", "pose"];
const SIM_POSE_KEYS = ["x_m", "distance_m", "heading_deg", "altitude_m", "airborne"];

const keys = (o: unknown) => Object.keys(o as object).sort();
const sorted = (k: string[]) => [...k].sort();
const at = (h: number, m: number) => timestampOf(localDate(2026, 11, 12, h, m, 0));

function engine(wall: () => number = () => at(7, 0), storage: KeyValueStorage | null = null): Engine {
  return new Engine({ storage, wallClock: wall, seed: 2, scheduler: null, housekeepingTimer: false });
}

describe("the status document", () => {
  it("has exactly the key sets of the Python status", () => {
    const e = engine();
    e.connectPilot();
    e.advance(2.5); // a full 2 s fps window after the first frame
    e.request("POST", "/api/hover-test/start");
    e.request("POST", "/api/sim/scenario", { name: "empty" });
    const s = e.status();
    expect(Object.keys(s)).toEqual(TOP_KEYS); // the Python order too
    expect(keys(s.link)).toEqual(sorted(LINK_KEYS));
    expect(keys(s.telemetry)).toEqual(sorted(TELEMETRY_KEYS));
    expect(keys(s.trim)).toEqual(sorted(TRIM_KEYS));
    expect(keys(s.pilot)).toEqual(sorted(PILOT_KEYS));
    expect(keys(s.vision)).toEqual(sorted(VISION_KEYS));
    expect(keys(s.vision.marker)).toEqual(sorted(MARKER_KEYS));
    expect(keys(s.vision.person)).toEqual(sorted(PERSON_KEYS));
    expect(keys(s.mission)).toEqual(sorted(MISSION_KEYS));
    expect(keys(s.mission.command)).toEqual(sorted(COMMAND_KEYS));
    expect(keys(s.mission.drift_assist)).toEqual(sorted(DRIFT_ASSIST_KEYS));
    expect(keys(s.mission.avoid)).toEqual(sorted(AVOID_KEYS));
    expect(keys(s.hover_test)).toEqual(sorted(HOVER_KEYS));
    expect(keys(s.care)).toEqual(sorted(CARE_KEYS));
    for (const dose of s.care.doses) expect(keys(dose)).toEqual(sorted(DOSE_STATUS_KEYS));
    expect(keys(s.sim)).toEqual(sorted(SIM_KEYS));
    expect(keys(s.sim!.pose)).toEqual(sorted(SIM_POSE_KEYS));
    expect(s.mode).toBe("sim");
    expect(s.vision.person).toEqual({ enabled: false, detected: false, count: 0, age_s: null });
    expect(s.link.video_live).toBe(true);
    expect(s.link.fps).toBeGreaterThan(10);
    expect(s.mission.avoid.mode).toBe("hold");
    expect(s.sim!.pose).toEqual({ x_m: 0, distance_m: 3.2, heading_deg: 0, altitude_m: 0, airborne: false });

    e.request("POST", "/api/mission/abort");
    expect(e.request("POST", "/api/sim/scenario", { name: "cart" }).status).toBe(200);
    e.advance(1.0);
    const c = e.status();
    expect(c.vision.obstacles.length).toBeGreaterThan(0);
    expect(keys(c.vision.obstacles[0])).toEqual(sorted(OBSTACLE_KEYS));
    for (const actor of c.sim!.actors) expect(keys(actor)).toEqual(sorted(ACTOR_KEYS));
  });
});

describe("the control channel", () => {
  it("holds one pilot at a time and answers each message type", () => {
    const e = engine();
    e.advance(0.5);
    const pilot = e.connectPilot()!;
    expect(pilot.hello).toEqual({ type: "hello", pilot: true });
    expect(e.connectPilot()).toBeNull(); // the transport closes that socket with 4001
    expect(pilot.receive({ type: "max_stick", value: 0.8 })).toEqual({ type: "ack", of: "max_stick" });
    expect(e.status().pilot.max_stick).toBe(0.8);
    expect(pilot.receive({ type: "max_stick", value: 0.1 })).toMatchObject({ type: "error", of: "max_stick", code: "bad_request" });
    expect(pilot.receive({ type: "max_stick", value: "x" })).toEqual({
      type: "error", of: "max_stick", code: "bad_request", message: "max_stick.value must be a number from 0.2 to 1.0",
    });
    expect(pilot.receive({ type: "calibrate" })).toEqual({ type: "ack", of: "calibrate" });
    expect(pilot.receive({ type: "takeoff_land" })).toEqual({ type: "ack", of: "takeoff_land" });
    expect(pilot.receive({ type: "estop" })).toEqual({ type: "ack", of: "estop", delivered: true });
    const refused = pilot.receive({ type: "takeoff_land" });
    expect(refused).toMatchObject({ type: "error", of: "takeoff_land", code: "estop_active" });
    expect((refused as { message: string }).message).toContain("emergency stop");
    expect(pilot.receive({ type: "calibrate" })).toMatchObject({ code: "estop_active" });
    expect(pilot.receive({ type: "estop_reset" })).toEqual({ type: "ack", of: "estop_reset" });
    expect(pilot.receive({ type: "axes", throttle: "up", yaw: 0, pitch: 0, roll: 0 })).toEqual({
      type: "error", of: "axes", code: "bad_request", message: "axes.throttle must be a number in [-1, 1]",
    });
    expect(pilot.receive({ type: "axes", throttle: 0, yaw: 0.5, pitch: 0, roll: 0 })).toBeNull();
    expect(pilot.receive([1, 2])).toEqual({ type: "error", of: null, code: "bad_request", message: "expected a JSON object" });
    expect(pilot.receiveText("not json")).toEqual({ type: "error", of: null, code: "bad_request", message: "invalid JSON" });
    pilot.close();
    expect(e.connectPilot()).not.toBeNull();
  });

  it("releasing the pilot aborts a run with pilot_link_lost", () => {
    const e = engine();
    const pilot = e.connectPilot()!;
    e.advance(1.0);
    expect(e.request("POST", "/api/mission/start", { automatic: true, dose_id: null }).status).toBe(200);
    e.advance(1.0);
    pilot.close();
    e.advance(0.1);
    const m = e.status().mission;
    expect([m.state, m.reason]).toEqual(["aborted", "pilot_link_lost"]);
    expect(m.blockers).toContain("no_pilot_link");
  });

  it("runs faster only while nobody flies by hand", () => {
    const e = engine();
    const pilot = e.connectPilot()!;
    expect(e.setSpeed(2)).toBe(true);
    pilot.receive({ type: "axes", throttle: 0, yaw: 1, pitch: 0, roll: 0 });
    expect(e.speed).toBe(1);
    e.advance(0.1);
    expect(e.setSpeed(2)).toBe(false);
    e.advance(1.0);
    expect(e.setSpeed(2)).toBe(true);
    expect(e.setSpeed(10)).toBe(false);
  });
});

describe("demo data", () => {
  it("seeds only the doses still ahead of the clock, and again on a new day", () => {
    expect(dosesAhead(localDate(2026, 11, 12, 7, 0)).map((d) => d.time)).toEqual(["08:00", "13:00", "20:00"]);
    expect(dosesAhead(localDate(2026, 11, 12, 15, 0)).map((d) => d.time)).toEqual(["20:00"]);
    expect(dosesAhead(localDate(2026, 11, 12, 21, 0))).toEqual([]);

    const storage = new MemoryStorage();
    let wall = at(15, 0);
    const first = engine(() => wall, storage);
    expect(first.status().care.doses.map((d) => [d.id, d.time, d.status])).toEqual([["d1", "20:00", "upcoming"]]);
    first.request("POST", "/api/schedule", { time: "21:00", label: "Mine (demo)" });
    // a reload the same day keeps the schedule
    const again = engine(() => wall, storage);
    expect(again.status().care.doses.map((d) => d.time)).toEqual(["20:00", "21:00"]);
    // the next morning: seeded afresh with the doses ahead
    wall = timestampOf(localDate(2026, 11, 13, 9, 30, 0));
    const tomorrow = engine(() => wall, storage);
    expect(tomorrow.status().care.doses.map((d) => [d.time, d.status])).toEqual([["13:00", "upcoming"], ["20:00", "upcoming"]]);
    expect(JSON.parse(storage.getItem(DEMO_KEY)!)).toEqual({ seeded_on: "2026-11-13" });
    // and while open across midnight
    wall = timestampOf(localDate(2026, 11, 14, 0, 0, 30));
    tomorrow.housekeeping();
    expect(tomorrow.status().care.doses.map((d) => d.time)).toEqual(["08:00", "13:00", "20:00"]);
  });

  it("keeps at most the newest 500 events in storage", () => {
    const storage = new MemoryStorage();
    const e = engine(() => at(7, 0), storage);
    for (let i = 0; i < EVENTS_KEEP + 40; i += 1) e.request("POST", "/api/doses/d1/acknowledge");
    e.core.store.addEvent("hover_test", { detail: { n: 1 } });
    for (let i = 0; i < EVENTS_KEEP + 40; i += 1) e.core.store.addEvent("hover_test", { detail: { n: i } });
    const lines = storage.getItem(STORAGE_KEYS.events)!.trim().split("\n");
    expect(lines).toHaveLength(EVENTS_KEEP);
    expect(JSON.parse(lines[lines.length - 1]!).detail).toEqual({ n: EVENTS_KEEP + 39 });
    const reloaded = engine(() => at(7, 0), storage);
    expect((reloaded.request("GET", "/api/events?limit=500").body as { events: unknown[] }).events).toHaveLength(EVENTS_KEEP);
  });

  it("resetDemoData starts again with fresh data", () => {
    const storage = new MemoryStorage();
    const e = engine(() => at(7, 0), storage);
    e.request("POST", "/api/schedule", { time: "09:30", label: "Extra (demo)" });
    e.request("PUT", "/api/mission/settings", { auto_fly: true });
    e.request("POST", "/api/doses/d1/acknowledge");
    e.resetDemoData();
    expect(e.status().care.doses.map((d) => d.id)).toEqual(["d1", "d2", "d3"]);
    expect(e.status().mission.auto_fly).toBe(false);
    expect((e.request("GET", "/api/events").body as { events: unknown[] }).events).toEqual([]);
  });

  it("works with storage that throws on every call (memory for the session)", () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    const e = engine(() => at(7, 0), broken);
    expect(e.status().care.doses).toHaveLength(3);
    const added = e.request("POST", "/api/schedule", { time: "09:30", label: "Extra (demo)" });
    expect(added.status).toBe(200);
    expect(e.request("POST", "/api/doses/d4/acknowledge").status).toBe(200);
    expect(e.status().care.doses.find((d) => d.id === "d4")!.status).toBe("acknowledged");
    e.resetDemoData();
    expect(e.status().care.doses).toHaveLength(3);
  });
});
