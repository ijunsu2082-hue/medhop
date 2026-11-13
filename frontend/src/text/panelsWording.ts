// Text added for the Pilot page's Station run, Manual flying and Setup and tuning panels.
// Plain statements of what the page does; nothing here claims more than the controls do.

import { BACKEND_KIND, type BackendKind } from "../transport/kind";

/** Printed under the on-screen sticks while they are disabled (the disabled recipe: the reason is beside the control). */
export const STICKPAD_LOCKED_REASON = "Locked: the control link is not connected, so these buttons send no stick input.";

// A browser build has no backend process and no drone in anyone's hand: the simulator runs in this page.

/** "What a station run does" on the Pilot page. */
export const PILOT_ABOUT_TEXT =
  "Fly a small toy drone from this laptop. A station run turns the drone until its camera sees the printed " +
  "station sign, flies toward it and stops. The Care page then shows that it arrived at the station.";
export const PILOT_ABOUT_BROWSER_TEXT =
  "Fly a simulated toy drone in this page. A station run turns the drone until its simulated camera sees the " +
  "station sign, flies toward it and stops. The Care page then shows that it arrived at the station.";

export function pilotAboutText(kind: BackendKind = BACKEND_KIND): string {
  return kind === "browser" ? PILOT_ABOUT_BROWSER_TEXT : PILOT_ABOUT_TEXT;
}

/** Under "Arrival calibration". Nobody can hold the simulated drone: in a browser build it is flown there. */
export const ARRIVAL_CALIBRATION_HINT = "Hold the drone by hand at the stopping distance, facing the sign, then press.";
export const ARRIVAL_CALIBRATION_BROWSER_HINT =
  "Fly the simulated drone to the stopping distance, facing the sign, then press.";

export function arrivalCalibrationHint(kind: BackendKind = BACKEND_KIND): string {
  return kind === "browser" ? ARRIVAL_CALIBRATION_BROWSER_HINT : ARRIVAL_CALIBRATION_HINT;
}

/** The label before the max-stick value the page last heard back ("Backend value: 0.50."). */
export function backendValueLabel(kind: BackendKind = BACKEND_KIND): string {
  return kind === "browser" ? "Value in the simulator" : "Backend value";
}
