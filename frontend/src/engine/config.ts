// Ports the Settings defaults and checks of backend/medhop/config.py that the engine needs.
//
// Naming in the engine: plain data records (configs, observations, snapshots) keep the Python field
// names in snake_case, so a Python dict, a fixture and the status JSON all use the same keys; functions,
// methods and properties are camelCase (seconds_since_toggle -> secondsSinceToggle).
//
// Left out (they only matter to the Python server or the real drone): turbodrone_backend, drone_ip,
// data_dir, yolo_weights, host, port, and Settings.from_env (a browser has no environment variables).

import type { Mode } from "../api/types";
import { pyFormatFixed, pyRepr, pyStrRepr, pyTupleRepr, radians, ValueError } from "./util/num";

export const DRONE_MODES = ["sim", "real"] as const;
export const PERSON_CHECK_MODES = ["auto", "on", "off"] as const;
/** "high": the display profile (a rendered room at 1280x720); "drone": 640x360 with blur, noise and JPEG q50. */
export const SIM_CAMERA_MODES = ["high", "drone"] as const;
/** Obstacle avoidance (experimental), SPEC section 11. */
export const AVOID_MODES = ["off", "hold"] as const;

export type PersonCheckMode = (typeof PERSON_CHECK_MODES)[number];
export type SimCameraMode = (typeof SIM_CAMERA_MODES)[number];
export type AvoidMode = (typeof AVOID_MODES)[number];

export interface Settings {
  drone: Mode;
  control_rate: number;
  marker_id: number;
  marker_size_m: number;
  /** Marker width (fraction of the frame width) that counts as arrived. Derived unless given. */
  arrive_width: number;
  /** Landing distance from the sign, in the program's own metre scale (camera_hfov_deg geometry). */
  land_distance_m: number;
  person_check: PersonCheckMode;
  /** Raw battery byte treated as low; -1 disables the check (the byte's meaning is unverified). */
  battery_low_raw: number;
  telemetry_fresh_s: number;
  hover_max_excursion_m: number;
  grace_min: number;
  /** Horizontal field of view of the drone camera. 70 matches the simulator; the real lens is unmeasured. */
  camera_hfov_deg: number;
  sim_camera: SimCameraMode;
  /**
   * Obstacle avoidance (experimental, simulator-tested only; SPEC section 11): "off" or "hold". "off"
   * here (Python's from_env defaults it to "hold" in simulator mode). A mode stored with the mission
   * settings wins over this.
   */
  avoid: AvoidMode;
}

/** Constructor arguments, as for the Python dataclass: every field optional, strings normalised. */
export interface SettingsInit {
  drone?: string;
  control_rate?: number;
  marker_id?: number;
  marker_size_m?: number;
  /** null or missing: derived from land_distance_m, marker_size_m and camera_hfov_deg. */
  arrive_width?: number | null;
  land_distance_m?: number;
  person_check?: string;
  battery_low_raw?: number;
  telemetry_fresh_s?: number;
  hover_max_excursion_m?: number;
  grace_min?: number;
  camera_hfov_deg?: number;
  sim_camera?: string;
  avoid?: string;
}

/** The dataclass defaults (arrive_width is null there: derived in __post_init__). */
export const SETTINGS_DEFAULTS = Object.freeze({
  drone: "sim",
  control_rate: 20.0,
  marker_id: 7,
  marker_size_m: 0.18,
  arrive_width: null,
  land_distance_m: 0.45,
  person_check: "auto",
  battery_low_raw: -1,
  telemetry_fresh_s: 3.0,
  hover_max_excursion_m: 0.5,
  grace_min: 15,
  camera_hfov_deg: 70.0,
  sim_camera: "high",
  avoid: "off",
} as const);

function normalise(value: string): string {
  return String(value).trim().toLowerCase();
}

function oneOf<T extends string>(value: string, options: readonly T[]): value is T {
  return (options as readonly string[]).includes(value);
}

/** Settings(...) with __post_init__: normalises the strings, validates, derives arrive_width. Throws ValueError. */
export function makeSettings(init: SettingsInit = {}): Settings {
  const merged = { ...SETTINGS_DEFAULTS, ...init };
  const drone = normalise(merged.drone);
  const personCheck = normalise(merged.person_check);
  const simCamera = normalise(merged.sim_camera);
  const avoid = normalise(merged.avoid);
  // Python checks the avoid mode first, right after normalising the strings.
  if (!oneOf(avoid, AVOID_MODES)) {
    throw new ValueError(`MEDHOP_AVOID must be one of ${pyTupleRepr(AVOID_MODES)}, got ${pyStrRepr(avoid)}`);
  }
  if (!oneOf(drone, DRONE_MODES)) {
    throw new ValueError(`MEDHOP_DRONE must be one of ${pyTupleRepr(DRONE_MODES)}, got ${pyStrRepr(drone)}`);
  }
  if (!oneOf(personCheck, PERSON_CHECK_MODES)) {
    throw new ValueError(
      `MEDHOP_PERSON_CHECK must be one of ${pyTupleRepr(PERSON_CHECK_MODES)}, got ${pyStrRepr(personCheck)}`,
    );
  }
  if (!oneOf(simCamera, SIM_CAMERA_MODES)) {
    throw new ValueError(`MEDHOP_SIM_CAMERA must be one of ${pyTupleRepr(SIM_CAMERA_MODES)}, got ${pyStrRepr(simCamera)}`);
  }
  const s = merged;
  if (!(1.0 <= s.control_rate && s.control_rate <= 100.0)) {
    throw new ValueError("MEDHOP_CONTROL_RATE must be between 1 and 100");
  }
  if (!(0 <= s.marker_id && s.marker_id < 50)) throw new ValueError("MEDHOP_MARKER_ID must be 0..49 (ArUco DICT_4X4_50)");
  if (!(0.02 <= s.marker_size_m && s.marker_size_m <= 1.0)) {
    throw new ValueError("MEDHOP_MARKER_SIZE_M must be between 0.02 and 1.0");
  }
  if (s.grace_min < 0) throw new ValueError("MEDHOP_GRACE_MIN must be >= 0");
  if (!(0.05 <= s.hover_max_excursion_m && s.hover_max_excursion_m <= 5.0)) {
    throw new ValueError("MEDHOP_HOVER_MAX_EXCURSION_M must be between 0.05 and 5.0");
  }
  if (!(30.0 <= s.camera_hfov_deg && s.camera_hfov_deg <= 150.0)) {
    throw new ValueError("MEDHOP_CAMERA_HFOV_DEG must be between 30 and 150");
  }
  // After the lens check: the derived arrive width uses camera_hfov_deg.
  if (!(0.35 <= s.land_distance_m && s.land_distance_m <= 3.0)) {
    throw new ValueError("MEDHOP_LAND_DISTANCE_M must be between 0.35 and 3.0");
  }
  const derived = s.arrive_width === null || s.arrive_width === undefined;
  let arriveWidth: number;
  if (s.arrive_width === null || s.arrive_width === undefined) {
    const half = radians(s.camera_hfov_deg) / 2.0;
    arriveWidth = s.marker_size_m / (2.0 * Math.tan(half) * s.land_distance_m);
  } else {
    arriveWidth = s.arrive_width;
  }
  if (!(0.03 <= arriveWidth && arriveWidth <= 0.8)) {
    if (derived) {
      throw new ValueError(
        `MEDHOP_LAND_DISTANCE_M=${pyRepr(s.land_distance_m)} gives an arrive width of ` +
          `${pyFormatFixed(arriveWidth, 3)}, outside 0.03..0.8 for this marker size and lens`,
      );
    }
    throw new ValueError("MEDHOP_ARRIVE_WIDTH must be between 0.03 and 0.8");
  }
  return {
    drone,
    control_rate: s.control_rate,
    marker_id: s.marker_id,
    marker_size_m: s.marker_size_m,
    arrive_width: arriveWidth,
    land_distance_m: s.land_distance_m,
    person_check: personCheck,
    battery_low_raw: s.battery_low_raw,
    telemetry_fresh_s: s.telemetry_fresh_s,
    hover_max_excursion_m: s.hover_max_excursion_m,
    grace_min: s.grace_min,
    camera_hfov_deg: s.camera_hfov_deg,
    sim_camera: simCamera,
    avoid,
  };
}

/** Settings.battery_check_enabled */
export function batteryCheckEnabled(settings: Settings): boolean {
  return settings.battery_low_raw >= 0;
}
