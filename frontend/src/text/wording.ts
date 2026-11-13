// Every code from SPEC section 6/7 mapped to plain English. Wording rules (SPEC section 1):
// never "delivered"; pickup is "acknowledged (self-reported)"; the person check is advisory only.

import type { AbortReason, BlockerCode, ControlErrorCode, DoseStatus, EventType, MissionState } from "../api/types";
import { formatClock } from "../logic/time";
import { BACKEND_KIND, type BackendKind } from "../transport/kind";
import { backendNameCapital } from "./shellWording";

export const BLOCKER_TEXT: Record<BlockerCode, string> = {
  no_video: "There is no live video from the drone.",
  estop_active: "Emergency stop is active. Press Reset before starting.",
  already_running: "A station run or hover test is already in progress.",
  // Revision 4: a simulated person counts too, with the person check off, so this names no source.
  person_in_view: "A person is in view of the camera. Clear the corridor first.",
  battery_low: "The battery reading is low (raw, unverified units). Land and change the battery.",
  marker_too_close: "The station sign already looks arrival-sized. Move the drone back from it first.",
  confirm_airborne_required: "Confirm that the drone is hovering before starting. The run never takes off by itself.",
  marker_not_visible: "The station sign must be in view of the camera.",
  no_pilot_link: "Open the Pilot page and keep it open: a run needs a pilot connected.",
  drone_flying: "The drone is already in the air. Land it first, or use Step by step.",
  recent_toggle: "Takeoff or landing was pressed a moment ago. Wait a few seconds.",
  obstacle_in_view: "Something is in the drone's path. Clear the corridor first.",
};

export const ABORT_TEXT: Record<AbortReason, string> = {
  marker_not_found: "The station sign was not found while turning to search (12 second limit).",
  marker_lost: "The station sign was lost from view during the approach and could not be found again.",
  off_axis: "The drone was too far to the side of the sign to continue safely.",
  video_stale: "The video stopped updating, so the run was stopped.",
  timeout: "The run took longer than the 45 second limit.",
  pilot_took_over: "The pilot gave manual input, so the run handed control back.",
  person_in_view: "A person came into view of the camera during the run.",
  battery_low: "The battery reading went low (raw, unverified units).",
  estop: "Emergency stop was pressed.",
  pilot_link_lost: "The Pilot page lost its control link, so the run was stopped. Reopen the Pilot page and land by hand.",
  unexpected_descent:
    "The drone looked like it was already coming down, so the run stopped without sending the landing command. Land by hand.",
  takeoff_refused: "The takeoff command was not accepted.",
  not_lined_up: "It got close to the sign but could not line up in front of it.",
  already_at_station: "It was already at the sign after takeoff. Put it back on its start spot.",
  // The first sentence is the reason alone: a message that says how it ended uses only that (see avoidWording.ts).
  path_blocked: "The way stayed blocked for 25 seconds. The drone landed where it was: clear the corridor and send it again.",
  obstacle_in_view: "Something was in the drone's path before takeoff, so it did not take off.",
};

export const MISSION_STATE_TEXT: Record<MissionState, string> = {
  idle: "Idle",
  countdown: "Counting down to takeoff",
  taking_off: "Taking off",
  searching: "Searching: turning slowly to find the station sign",
  approaching: "Approaching the station sign",
  aligning: "Lining up over the landing spot",
  arrived: "Arrived at station, holding still",
  landing: "Landing at the station",
  done: "Done",
  aborted: "Stopped early",
  hover_test: "Hover test running",
};

export const EVENT_TEXT: Record<EventType, string> = {
  reminder_due: "Reminder: dose is due",
  run_started: "Station run started",
  arrived_at_station: "Arrived at station",
  run_aborted: "Station run stopped early",
  pickup_acknowledged: "Pickup acknowledged (self-reported)",
  needs_attention: "Needs attention: not acknowledged in time",
  hover_test: "Hover test",
  auto_run_skipped: "Automatic flight skipped",
};

export const DOSE_STATUS_TEXT: Record<DoseStatus, string> = {
  upcoming: "Upcoming",
  due: "Due",
  arrived: "Arrived at station",
  acknowledged: "Acknowledged (self-reported)",
  needs_attention: "Needs attention",
};

function lookup<K extends string>(table: Record<K, string>, code: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code as K] : undefined;
}

/** Shown for a code this page has no text for yet, so a new backend code never renders blank. */
function unknownCode(sentence: string, code: string): string {
  const c = code.trim();
  return c ? `${sentence} (code: ${c}).` : `${sentence}.`;
}

export function blockerText(code: string): string {
  return lookup(BLOCKER_TEXT, code) ?? unknownCode("Not available right now, for a reason this page does not describe yet", code);
}

export function abortText(code: string | null): string {
  if (!code) return "No reason was given.";
  return lookup(ABORT_TEXT, code) ?? unknownCode("Stopped for a reason this page does not describe yet", code);
}

export function missionStateText(state: string): string {
  return lookup(MISSION_STATE_TEXT, state) ?? unknownCode("Unrecognised state", state);
}

export function eventText(type: string): string {
  return lookup(EVENT_TEXT, type) ?? unknownCode("Other event", type);
}

/** Why drift assist switched itself off (backend mission/steering.py). Each entry is a whole sentence. */
export const DRIFT_ASSIST_DISABLED_TEXT: Record<string, string> = {
  off_axis_worsening:
    "Drift assist switched itself off because its correction was making the approach worse. Check the trim sign.",
};

/** A whole sentence for the drift-assist panel. Unknown codes get a generic sentence with the code after it. */
export function driftDisabledText(code: string): string {
  const known = lookup(DRIFT_ASSIST_DISABLED_TEXT, code);
  if (known) return known;
  const c = code.trim();
  // A backend that already sends a sentence is shown after the lead-in; a bare code is shown as a code.
  if (/\s/.test(c)) return `Drift assist switched itself off for this run: ${c}`;
  return unknownCode("Drift assist switched itself off for this run, for a reason this page does not describe yet", c);
}

/** Control-socket refusal codes (SPEC 10.4) in plain English. */
export const CONTROL_ERROR_TEXT: Record<ControlErrorCode, string> = {
  landing_in_progress: "Not sent: the station run just sent the landing command. Wait a few seconds before toggling again.",
  drone_link_down: "Not sent: the drone link is down, so the command could not reach the drone.",
  estop_active: "Not sent: emergency stop is active. Reset it first.",
  toggle_guard: "Not sent: the backend is holding off takeoff/land toggles for a moment. Wait a few seconds, then try again.",
};

/** toggle_guard in a browser build, where the simulator in this page holds the toggles off. */
export const TOGGLE_GUARD_BROWSER_TEXT =
  "Not sent: the simulator in this page is holding off takeoff/land toggles for a moment. Wait a few seconds, then try again.";

/** Text for a control-socket error: the code's sentence when known, otherwise the server's own message. */
export function controlErrorText(
  code: string | undefined,
  message: string | undefined,
  kind: BackendKind = BACKEND_KIND,
): string {
  if (kind === "browser" && code === "toggle_guard") return TOGGLE_GUARD_BROWSER_TEXT;
  const known = code ? lookup(CONTROL_ERROR_TEXT, code) : undefined;
  if (known) return known;
  const m = (message ?? "").trim();
  if (m) return `${kind === "browser" ? "Simulator" : "Backend"}: ${m}`;
  return unknownCode(`${backendNameCapital(kind)} refused the command, for a reason this page does not describe yet`, code ?? "");
}

/** "arrived at station 08:12", "acknowledged 08:20 (self-reported)" etc. Times may be "HH:MM" or (older backend) numbers. */
export function doseStatusLine(d: {
  status: DoseStatus;
  arrived_at: string | number | null;
  acknowledged_at: string | number | null;
}): string {
  const arrived = formatClock(d.arrived_at);
  const acked = formatClock(d.acknowledged_at);
  switch (d.status) {
    case "arrived":
      return arrived ? `Arrived at station ${arrived}` : "Arrived at station";
    case "acknowledged":
      return acked ? `Acknowledged ${acked} (self-reported)` : "Acknowledged (self-reported)";
    case "needs_attention":
      return arrived ? `Needs attention (arrived at station ${arrived}, not acknowledged)` : "Needs attention";
    default:
      return lookup(DOSE_STATUS_TEXT, d.status) ?? unknownCode("Unrecognised status", String(d.status));
  }
}

/** End-of-run message on the Pilot page, keyed by `mission.last_landing` (SPEC 10.2). "unknown": null or missing. */
export const LAST_LANDING_TEXT = {
  sent: "Arrived at station. The landing command was sent once: check that the drone has landed.",
  skipped_settle_guard_undecided:
    "Arrived at station. The landing command was NOT sent (the descent check could not decide). Land by hand.",
  refused_by_mixer:
    "Arrived at station. The landing command was NOT sent (the safety layer refused it, for example because you used the controls just before or the drone link was down). Land by hand.",
  off: "Arrived at station. Landing on arrival is off: land by hand.",
  unknown: "Arrived at station. Check whether the drone has landed; land by hand if not.",
} as const;

export const FOOTER_TEXT =
  "Prototype. Demo data only. Not a medical device. Does not confirm that medicine was taken.";
