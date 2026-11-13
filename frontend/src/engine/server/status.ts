// Ports MedHopCore.status() and MedHopCore.sim_snapshot() of backend/medhop/server.py: the status document
// that GET /api/status returns and WS /ws/status pushes (SPEC 7, 10.4, 11.6), with the same keys in the same
// order and the same rounding (Python's round(), pyRound). The vision part is fed by VisionBook, the port of the
// vision worker's bookkeeping.
//
// The browser has no person check (vision/person.ts): `vision.person` always reports it disabled, exactly what
// Python reports without local weights. `mode` is always "sim".

import type { Mode } from "../../api/types";
import { batteryCheckEnabled, type Settings } from "../config";
import { careSnapshot, type CareSnapshot } from "../care/status";
import type { CareStore } from "../care/store";
import type { SimLink } from "../drone/sim";
import type { ActorStatus } from "../drone/simActors";
import type { ControlMixer } from "../mixer";
import type { HoverSnapshot, MissionRunner, ObstacleSnapshot, RunnerSnapshot } from "../mission/runner";
import { pyRound } from "../util/num";
import type { PersonStatus } from "../vision/person";
import type { VisionBook } from "./visionBook";

/** a person-check result older than this is not shown as detected */
export const PERSON_FRESH_S = 2.0;

/** Python's _round(value, digits): None stays None. */
export function roundOrNull(value: number | null | undefined, digits = 3): number | null {
  return value === null || value === undefined ? null : pyRound(Number(value), digits);
}

export interface StatusLink {
  video_live: boolean;
  frame_age_s: number | null;
  fps: number | null;
  control_up: boolean;
  drone_seen: boolean;
  sticks_blocked: boolean;
}

export interface StatusTelemetry {
  simulated: boolean;
  age_s: number | null;
  fly_state_raw: number;
  battery_raw: number;
  flags_raw: number;
  battery_low: boolean;
  battery_check_enabled: boolean;
}

export interface StatusMarker {
  id: number;
  cx: number | null;
  cy: number | null;
  width: number | null;
  age_s: number | null;
}

export interface StatusPerson {
  enabled: boolean;
  detected: boolean;
  count: number;
  age_s: number | null;
}

/** sim.pose: where the simulated drone is now (simulator truth), for a plan view. */
export interface StatusSimPose {
  x_m: number;
  distance_m: number;
  heading_deg: number;
  altitude_m: number;
  airborne: boolean;
}

export interface StatusSim {
  scenario: string;
  actors: ActorStatus[];
  pose: StatusSimPose;
}

/** The status document (api/types.ts Status), as this engine builds it. */
export interface EngineStatus {
  server_time: number;
  mode: Mode;
  link: StatusLink;
  telemetry: StatusTelemetry | null;
  trim: { roll: number | null; pitch: number | null };
  pilot: { manual_active: boolean; max_stick: number | null; estop_active: boolean; estop_delivered: boolean };
  vision: {
    marker: StatusMarker | null;
    person: StatusPerson;
    brightness: number | null;
    dark: boolean;
    obstacles: ObstacleSnapshot[];
  };
  mission: RunnerSnapshot;
  hover_test: HoverSnapshot | null;
  care: CareSnapshot;
  sim: StatusSim | null;
}

/** What status() reads. */
export interface StatusSources {
  now: number;
  wallNow: number;
  nowLocal: Date;
  settings: Settings;
  link: SimLink;
  mixer: ControlMixer;
  vision: VisionBook;
  person: PersonStatus;
  runner: MissionRunner;
  store: CareStore;
}

/** MedHopCore.sim_snapshot(). */
export function simSnapshot(link: SimLink): StatusSim | null {
  if (link.mode !== "sim") return null;
  const pose = link.pose();
  return {
    scenario: link.scenario,
    actors: link.actorsNow().map((a) => a.asStatus()),
    pose: {
      x_m: pyRound(pose.x_m, 3),
      distance_m: pyRound(pose.distance_m, 3),
      heading_deg: pyRound(pose.heading_deg, 1),
      altitude_m: pyRound(pose.altitude_m, 3),
      airborne: pose.airborne === true,
    },
  };
}

/** MedHopCore.status(). */
export function buildStatus(s: StatusSources): EngineStatus {
  const now = s.now;
  const vision = s.vision.snapshot(now);
  const mixer = s.mixer.snapshot(now);
  const telemetry = s.link.telemetry();
  const person = s.person;

  let telemetryOut: StatusTelemetry | null = null;
  if (telemetry !== null) {
    const age = Math.max(0.0, now - telemetry.timestamp);
    const checkEnabled = batteryCheckEnabled(s.settings);
    telemetryOut = {
      simulated: s.link.mode === "sim",
      age_s: roundOrNull(age, 2),
      fly_state_raw: Math.trunc(telemetry.fly_state_raw),
      battery_raw: Math.trunc(telemetry.battery_raw),
      flags_raw: Math.trunc(telemetry.flags_raw),
      // Only a fresh reading counts, and only when the check is on (the byte is unverified).
      battery_low:
        checkEnabled && age < s.settings.telemetry_fresh_s && telemetry.battery_raw <= s.settings.battery_low_raw,
      battery_check_enabled: checkEnabled,
    };
  }

  let markerOut: StatusMarker | null = null;
  if (vision.marker !== null) {
    markerOut = {
      id: vision.marker.id,
      cx: roundOrNull(vision.marker.cx, 4),
      cy: roundOrNull(vision.marker.cy, 4),
      width: roundOrNull(vision.marker.width, 4),
      age_s: roundOrNull(vision.marker_age_s, 2),
    };
  }

  const personAge = person.ts === null ? null : Math.max(0.0, now - person.ts);
  const personFresh = personAge !== null && personAge <= PERSON_FRESH_S;
  return {
    server_time: s.wallNow,
    mode: s.link.mode,
    link: {
      video_live: vision.video_live,
      frame_age_s: roundOrNull(vision.frame_age_s, 2),
      fps: roundOrNull(vision.fps, 1),
      control_up: s.link.controlUp() === true,
      drone_seen: s.link.droneSeen() === true,
      sticks_blocked: mixer.sticks_blocked,
    },
    telemetry: telemetryOut,
    trim: { roll: roundOrNull(mixer.trim_roll, 4), pitch: roundOrNull(mixer.trim_pitch, 4) },
    pilot: {
      manual_active: mixer.manual_active,
      max_stick: roundOrNull(mixer.max_stick, 3),
      estop_active: mixer.estop_active,
      estop_delivered: mixer.estop_confirmed, // the motor cut, SPEC 10.4
    },
    vision: {
      marker: markerOut,
      person: {
        enabled: person.enabled === true,
        detected: person.enabled && person.detected && personFresh,
        count: person.enabled && personFresh ? Math.trunc(person.count) : 0,
        age_s: person.enabled ? roundOrNull(personAge, 2) : null,
      },
      brightness: roundOrNull(vision.brightness, 1),
      dark: vision.dark,
      // Obstacles in the newest frame with their estimated distance (null: base out of the picture, counted as
      // very close) and sideways position: the simulated actors.
      obstacles: s.runner.obstaclesSnapshot(now),
    },
    mission: s.runner.snapshot(now),
    hover_test: s.runner.hoverSnapshot(now),
    care: careSnapshot(s.store, s.nowLocal, s.settings.grace_min),
    sim: simSnapshot(s.link),
  };
}
