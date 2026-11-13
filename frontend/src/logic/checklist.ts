import type { Obstacle, Status, Telemetry } from "../api/types";
import { obstacleNoun } from "../text/avoidWording";
import { BACKEND_KIND, type BackendKind } from "../transport/kind";

/** "info": shown without a pass/fail judgement (e.g. the battery check is off on the backend). */
export type Verdict = "pass" | "warn" | "fail" | "info";

export interface CheckRow {
  id: string;
  label: string;
  verdict: Verdict;
  text: string;
}

const f2 = (n: number) => n.toFixed(2);

/** Telemetry older than this is "no recent reading" (SPEC 10.1: treated as absent for decisions). */
export const TELEMETRY_STALE_S = 3;

export const BATTERY_CHECK_OFF_TEXT = "Battery check is off (the meaning of this number has not been verified on this drone)";
/** A browser build: there is no drone to verify the number on; it comes from the simulator. */
export const BATTERY_CHECK_OFF_BROWSER_TEXT = "Battery check is off (this number is simulated)";

/**
 * The person check analyses camera pictures: a browser build has neither, so the row says so instead of "Off".
 * (The simulated people are known to the simulator and handled as they are with the Python simulator.)
 */
export const PERSON_CHECK_BROWSER_TEXT = "Not part of the browser simulator.";

/**
 * The battery line: the raw byte and its age. "No recent reading" when older than 3 s (or of unknown age).
 * When the backend's battery check is off there is no pass/fail, only the number.
 */
export function batteryLine(t: Telemetry | null, kind: BackendKind = BACKEND_KIND): { verdict: Verdict; text: string } {
  const offText = kind === "browser" ? BATTERY_CHECK_OFF_BROWSER_TEXT : BATTERY_CHECK_OFF_TEXT;
  if (!t || t.battery_raw === null) return { verdict: "warn", text: "No reading yet (raw, unverified units)" };
  const sim = t.simulated ? ", simulated" : "";
  const age = t.age_s !== null && Number.isFinite(t.age_s) ? `${t.age_s.toFixed(1)} s ago` : "age unknown";
  const raw = `raw ${t.battery_raw}, ${age} (raw, unverified units${sim})`;
  const checkOff = t.battery_check_enabled === false;
  const stale = t.age_s === null || !Number.isFinite(t.age_s) || t.age_s > TELEMETRY_STALE_S;
  if (stale) {
    return {
      verdict: checkOff ? "info" : "warn",
      text: `No recent reading. Last: ${raw}${checkOff ? `. ${offText}` : ""}`,
    };
  }
  if (checkOff) return { verdict: "info", text: `${raw}. ${offText}` };
  return { verdict: t.battery_low ? "fail" : "pass", text: `${t.battery_low ? "Low: " : ""}${raw}` };
}

/**
 * The backend estimates obstacle distances for a camera at hover height (in the simulator with the drone on the
 * ground, for the camera's ground height). A base just under the horizon reads as very far (SPEC 11.4 uses the same
 * 8 m limit), so a longer estimate is not shown as a distance.
 */
export const PATH_DISTANCE_MAX_M = 8;

/** "object about 2.7 m ahead", "person closer than about 2.5 m" (distance null: its base is below the picture), or "object ahead" when the estimate is not usable. */
function pathItem(o: Obstacle): string {
  const noun = obstacleNoun(o.kind);
  const d = o.distance_m;
  if (d === null) return `${noun} closer than about 2.5 m`;
  if (Number.isFinite(d) && d >= 0 && d <= PATH_DISTANCE_MAX_M) return `${noun} about ${d.toFixed(1)} m ahead`;
  return `${noun} ahead`;
}

/** Nearest first: too near to measure (null) before any measured distance. */
function nearer(a: Obstacle, b: Obstacle): number {
  const da = a.distance_m ?? -1;
  const db = b.distance_m ?? -1;
  return da - db;
}

/**
 * The "Path ahead" line, from `vision.obstacles` (SPEC 11.6). Info without the field (older backend), without live
 * video, or on the real drone with the person check off (nothing can be seen then). On the real drone only people
 * are detected, and the text says so.
 */
export function pathAheadLine(s: Pick<Status, "mode" | "link" | "vision">): { verdict: Verdict; text: string } {
  const obstacles = s.vision.obstacles;
  if (!Array.isArray(obstacles)) return { verdict: "info", text: "Not reported by this backend. Check the corridor by eye." };
  if (!s.link.video_live) return { verdict: "info", text: "Not known without live video" };
  const real = s.mode === "real";
  if (real && !s.vision.person.enabled) {
    return { verdict: "info", text: "Not checked: the person check is off. Check the corridor by eye." };
  }
  const inLane = obstacles.filter((o) => o.in_lane).sort(nearer);
  if (inLane.length === 0) {
    return real
      ? { verdict: "pass", text: "No person in the way. Objects are not detected on this drone: check by eye." }
      : { verdict: "pass", text: "Nothing in the way" };
  }
  const more = inLane.length - 1;
  return { verdict: "warn", text: `In the way: ${pathItem(inLane[0]!)}${more > 0 ? `, and ${more} more` : ""}` };
}

/** Pre-flight checklist, derived only from the status snapshot (and this build's backend kind). */
export function preflightChecklist(s: Status, kind: BackendKind = BACKEND_KIND): CheckRow[] {
  const rows: CheckRow[] = [];

  rows.push(
    s.link.video_live
      ? {
          id: "video",
          label: "Video",
          verdict: "pass",
          text: s.link.fps !== null ? `Live, ${s.link.fps.toFixed(1)} fps` : "Live",
        }
      : { id: "video", label: "Video", verdict: "fail", text: "No live video" },
  );

  const m = s.vision.marker;
  const arrive = s.mission.arrive_width;
  if (!m) {
    rows.push({ id: "marker", label: "Station sign", verdict: "warn", text: "Not in view" });
  } else if (m.width >= arrive) {
    rows.push({
      id: "marker",
      label: "Station sign",
      verdict: "warn",
      text: `In view, width ${f2(m.width)} is already at or above arrive width ${f2(arrive)}. Move back.`,
    });
  } else {
    rows.push({
      id: "marker",
      label: "Station sign",
      verdict: "pass",
      text: `In view (id ${m.id}), width ${f2(m.width)} of frame, arrive at ${f2(arrive)}`,
    });
  }

  const p = s.vision.person;
  if (!p.enabled && kind === "browser") {
    rows.push({ id: "person", label: "Advisory person check", verdict: "info", text: PERSON_CHECK_BROWSER_TEXT });
  } else if (!p.enabled) {
    rows.push({ id: "person", label: "Advisory person check", verdict: "warn", text: "Off. Check the corridor by eye." });
  } else if (p.detected) {
    rows.push({
      id: "person",
      label: "Advisory person check",
      verdict: "fail",
      text: p.count > 1 ? `${p.count} people in view` : "Person in view",
    });
  } else {
    rows.push({ id: "person", label: "Advisory person check", verdict: "pass", text: "Clear (advisory only, not a safety system)" });
  }

  rows.push({ id: "path", label: "Path ahead", ...pathAheadLine(s) });

  const b = s.vision.brightness;
  rows.push(
    s.vision.dark
      ? {
          id: "light",
          label: "Light",
          verdict: "warn",
          text: `Too dark for position hold${b !== null ? ` (brightness ${b.toFixed(0)})` : ""}`,
        }
      : { id: "light", label: "Light", verdict: "pass", text: `Brightness ok${b !== null ? ` (${b.toFixed(0)})` : ""}` },
  );

  rows.push({ id: "battery", label: "Battery", ...batteryLine(s.telemetry, kind) });

  rows.push(
    s.pilot.estop_active
      ? { id: "estop", label: "Emergency stop", verdict: "fail", text: "Active. Reset before flying." }
      : { id: "estop", label: "Emergency stop", verdict: "pass", text: "Not active" },
  );

  return rows;
}
