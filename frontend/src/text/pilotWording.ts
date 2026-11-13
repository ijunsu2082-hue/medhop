// Text for the Pilot page's camera figure, its caption and the command-strip readout.
// Honesty rules (README, tests/test_honest_scope.py): the simulator picture is never called the drone's 640x360
// stream, marker detection is never called AI, and the readout is built only from measured values.

import type { ModeChange } from "../logic/modeGuard";
import type { VideoHealth } from "../logic/videoHealth";
import type { StreamState } from "../logic/streamController";
import type { BackendKind } from "../transport/kind";

export type PilotMode = "sim" | "real";
export type FrameSize = { width: number; height: number };
export type RailTone = "pass" | "warn" | "fail" | "info";

export const CAPTION_DETECTION =
  "The station sign is detected with ArUco (classical computer vision). Person boxes are an advisory check only.";
export const CAPTION_REAL = "640x360 stream from the drone, shown enlarged.";
export const CAPTION_SIM =
  "Simulator view: a room drawn by the simulator. It is not a camera recording and not the drone's stream.";
export const CAPTION_SIM_CLEAN =
  "It is drawn cleaner than the real drone's 640x360 camera, so the sign is easier to detect here than in real flight.";
export const CAPTION_SIM_DRONE_LIKE =
  "This profile adds noise, blur and compression to resemble the real drone's 640x360 camera.";

/** Width of the real drone's stream. A simulator frame wider than this is the clean display profile. */
export const DRONE_FRAME_WIDTH = 640;

// A browser build (the simulator runs in this page) has no camera and no image analysis at all: the picture is a
// drawing, and the sign's position is computed from the simulator's own geometry.
export const CAPTION_BROWSER_PICTURE =
  "Simulator view: a line drawing made by the simulator running in this page. It is not a camera picture.";
export const CAPTION_BROWSER_DETECTION =
  "No picture is analysed: the station sign's position comes from the simulator's geometry, with noise and " +
  "dropped frames added, not from OpenCV. The people and objects are simulated.";

/**
 * The caption under the camera figure, as sentences. `frame` is the picture's natural size; pass it only while
 * the picture is live or delayed (otherwise null), so a stale size never picks the wording. `backend` is this
 * build's backend (transport kind); in a browser build the caption is the same whatever the mode and size.
 */
export function cameraCaption(
  mode: PilotMode | null | undefined,
  frame: FrameSize | null | undefined,
  backend: BackendKind = "python",
): string[] {
  if (backend === "browser") return [CAPTION_BROWSER_PICTURE, CAPTION_BROWSER_DETECTION];
  if (mode === "real") return [CAPTION_REAL, CAPTION_DETECTION];
  if (mode === "sim") {
    if (!frame || !(frame.width > 0)) return [CAPTION_SIM, CAPTION_DETECTION];
    return [CAPTION_SIM, frame.width > DRONE_FRAME_WIDTH ? CAPTION_SIM_CLEAN : CAPTION_SIM_DRONE_LIKE, CAPTION_DETECTION];
  }
  return [CAPTION_DETECTION];
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * The camera head readout, built only from measurements: the image's natural size, link.fps and
 * link.frame_age_s. A missing or non-finite part is left out; with nothing measured it is "".
 */
export function headReadout(
  frame: FrameSize | null | undefined,
  fps: number | null | undefined,
  frameAgeS: number | null | undefined,
): string {
  const parts: string[] = [];
  if (frame && finite(frame.width) && finite(frame.height) && frame.width > 0 && frame.height > 0) {
    parts.push(`${Math.round(frame.width)}x${Math.round(frame.height)}`);
  }
  if (finite(fps)) parts.push(`${Number.isInteger(fps) ? fps : fps.toFixed(1)} fps`);
  if (finite(frameAgeS)) parts.push(`frame ${frameAgeS.toFixed(2)} s`);
  return parts.join(" · ");
}

export function signValue(inView: boolean): string {
  return inView ? "In view" : "Not in view";
}

/**
 * The VIDEO value in the camera rail and the strip readout. The backend's view decides (health); a stream this
 * window lost while the backend still has frames reads "Reconnecting".
 */
export function videoRailValue(
  health: VideoHealth,
  streamState: StreamState | null | undefined,
  frameAgeS: number | null | undefined,
): string {
  switch (health) {
    case "unreachable":
      return "Backend not reachable";
    case "waiting":
      return "Waiting for status";
    case "no_video":
      return "No video";
    case "delayed":
      if (streamState === "interrupted") return "Reconnecting";
      return finite(frameAgeS) ? `Delayed ${frameAgeS.toFixed(1)} s` : "Delayed";
    case "live":
      return streamState === "interrupted" ? "Reconnecting" : "Live";
  }
}

export function videoRailTone(health: VideoHealth, streamState: StreamState | null | undefined): RailTone {
  if (health === "unreachable" || health === "no_video") return "fail";
  if (health === "waiting") return "info";
  if (health === "delayed" || streamState === "interrupted") return "warn";
  return "pass";
}

/**
 * The blocking banner on the Pilot page once the backend's mode changed while the page was open
 * (logic/modeGuard.ts). The flight controls stay locked until the page is reloaded; the emergency stop never is.
 */
export function modeChangedText(change: ModeChange): string {
  const name = (m: PilotMode) => (m === "real" ? "the real drone" : "the simulator");
  return (
    `The backend has switched from ${name(change.from)} to ${name(change.to)} while this page was open. ` +
    "Flight controls on this page are locked. The emergency stop still works. Reloading the page clears this."
  );
}

/** Why takeoff/land and level calibration are unavailable while the mode guard has tripped. */
export const CONTROLS_LOCKED_REASON = "Not available: controls are locked because the backend switched mode.";

/** The control messages a tripped mode guard refuses, by type, in the words the Pilot page uses for them. */
const LOCKED_CONTROL_NAMES: Record<string, string> = {
  axes: "stick input",
  takeoff_land: "takeoff / land",
  calibrate: "level calibration",
  max_stick: "max stick",
  estop_reset: "emergency stop reset",
};

/** The reason a control message was not sent while the mode guard has tripped (logic/modeGuard.ts). */
export function controlLockedText(type: string): string {
  const name = LOCKED_CONTROL_NAMES[type] ?? "that command";
  return `Not sent: ${name}. Controls are locked because the backend switched mode; only the emergency stop is sent.`;
}

/**
 * The detail of a request refused on this page while the mode guard has tripped. Panels show it after their own
 * prefix ("Start failed: ...", "Not saved: ...").
 */
export const REQUEST_LOCKED_TEXT =
  "Controls are locked because the backend switched mode while this page was open. Reload the page to clear this.";

/** The checklist heading summary: counts in the order fail, warn, pass, info, zero counts left out. */
export function checklistSummary(rows: ReadonlyArray<{ verdict: "pass" | "warn" | "fail" | "info" }>): string {
  const order = ["fail", "warn", "pass", "info"] as const;
  return order
    .map((v) => [v, rows.filter((r) => r.verdict === v).length] as const)
    .filter(([, n]) => n > 0)
    .map(([v, n]) => `${n} ${v}`)
    .join(" · ");
}

/**
 * A strip readout value without the legend it repeats: "Control link: refused" under the legend CONTROL LINK is
 * shown as "Refused". The full, unchanged sentence is still given to assistive tech by the caller.
 */
export function withoutLegend(text: string, prefix: string): string {
  if (!text.toLowerCase().startsWith(prefix.toLowerCase())) return text;
  const rest = text.slice(prefix.length).trimStart();
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : text;
}
