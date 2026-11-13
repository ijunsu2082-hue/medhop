// Words for waiting for people and obstacles (SPEC section 11). It slows, waits and lands where it is; it never
// steers round anything. Rules: say what it does, never call it a safety system, never say it prevents anything,
// never "deliver", never "AI". Tested in avoidWording.test.ts.

import type { Mode, MissionAvoid, SimScenarioName } from "../api/types";
import { backendNameCapital } from "./shellWording";
import { ABORT_TEXT, abortText, blockerText } from "./wording";

// ---------------------------------------------------------------- what it is reacting to

/** Metres to one decimal, or null for a missing, negative or non-finite value. */
function metres1(x: unknown): string | null {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? x.toFixed(1) : null;
}

/** "person", "object", or "something" for a missing or unknown kind. */
export function obstacleNoun(kind: unknown): string {
  return kind === "person" || kind === "object" ? kind : "something";
}

/**
 * "person 2.6 m ahead". When the distance is null the thing's base is below the picture, which at the hover
 * height means nearer than about 2.5 m: "person closer than about 2.5 m".
 */
export function obstaclePhrase(kind: unknown, distance: unknown): string {
  const d = metres1(distance);
  return d !== null ? `${obstacleNoun(kind)} ${d} m ahead` : `${obstacleNoun(kind)} closer than about 2.5 m`;
}

// ---------------------------------------------------------------- the live line during a run

export interface AvoidLineView {
  /** "pass": filled mark. "warn": hollow mark. Waiting and blocked are not faults, so never "fail". */
  tone: "pass" | "warn";
  text: string;
}

/**
 * One line for `mission.avoid`: "Path clear", "Slowing: person 2.9 m ahead", "Waiting: person 2.6 m ahead",
 * "Waiting: object very close", "Path blocked". null when avoidance is off or it has no state yet.
 */
export function avoidLine(a: MissionAvoid | null | undefined): AvoidLineView | null {
  if (!a || a.mode !== "hold" || a.state === null || a.state === undefined) return null;
  switch (a.state) {
    case "clear":
      return { tone: "pass", text: "Path clear" };
    case "slow":
      return { tone: "warn", text: `Slowing: ${obstaclePhrase(a.kind, a.distance_m)}` };
    case "hold":
      return { tone: "warn", text: `Waiting: ${obstaclePhrase(a.kind, a.distance_m)}` };
    case "blocked":
      return { tone: "warn", text: "Path blocked" };
    default: {
      const c = String(a.state).trim();
      return { tone: "warn", text: c ? `Waiting for a reason this page does not describe yet (code: ${c})` : "Waiting" };
    }
  }
}

// ---------------------------------------------------------------- the switch

export const AVOID_SWITCH_LABEL = "Wait for people and obstacles";

/** Under the switch in the Automatic view: an automatic run lands where it is when the way stays blocked. */
export const AVOID_HINT =
  "It slows and waits when something is in its way, and lands where it is if the way stays blocked. Tested in the simulator only.";

/** Under the switch in the Step by step view: a step-by-step run never lands by itself, it stops and you land it. */
export const AVOID_HINT_STEPS =
  "It slows and waits when something is in its way, and stops the run if the way stays blocked. Tested in the simulator only.";

export const AVOID_HINT_REAL =
  "On this drone only people are detected, and only while the optional person check is running. With this off, a person that check sees stops the run.";

export const AVOID_HINT_PERSON_CHECK_OFF = "The person check is off now.";

/** The sentences under the switch. The real drone adds what it can and cannot detect. */
export function avoidHint(mode: Mode | string, personCheckEnabled: boolean, view: "auto" | "steps" = "auto"): string {
  const base = view === "steps" ? AVOID_HINT_STEPS : AVOID_HINT;
  if (mode !== "real") return base;
  return [base, AVOID_HINT_REAL, personCheckEnabled ? "" : AVOID_HINT_PERSON_CHECK_OFF].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- the simulator's corridor

/** The scenarios in the order the Corridor list shows them. */
export const SCENARIOS: readonly SimScenarioName[] = ["empty", "crossing", "standing", "cart", "blocked"];

export const SCENARIO_TEXT: Record<SimScenarioName, string> = {
  empty: "Empty corridor",
  crossing: "A person walks across",
  standing: "A person stands in the way",
  cart: "A trolley is in the way",
  blocked: "The corridor is blocked",
};

/** A scenario's name in plain words; an unknown name gets a generic one with the name after it. */
export function scenarioText(name: string): string {
  if (Object.prototype.hasOwnProperty.call(SCENARIO_TEXT, name)) return SCENARIO_TEXT[name as SimScenarioName];
  const c = name.trim();
  return c ? `Another corridor (code: ${c})` : "Another corridor";
}

/** Why the corridor could not be changed (409 blockers from `POST /api/sim/scenario`). */
export const SCENARIO_REFUSAL_TEXT: Record<string, string> = {
  not_simulator: "The corridor can only be set in the simulator.",
  already_running: "Wait for the run to end before changing the corridor.",
};

export function scenarioRefusalText(codes: readonly string[]): string {
  const known = (c: string) =>
    Object.prototype.hasOwnProperty.call(SCENARIO_REFUSAL_TEXT, c) ? SCENARIO_REFUSAL_TEXT[c]! : blockerText(c);
  const texts = codes.map((c) => known(String(c)));
  return texts.length ? texts.join(" ") : `${backendNameCapital()} refused to change the corridor.`;
}

// ---------------------------------------------------------------- how a blocked run ended

function firstSentence(text: string): string {
  const match = text.trim().match(/^[^.]*\./);
  return match ? match[0] : text;
}

/** path_blocked's reason alone: "The way stayed blocked for 25 seconds." */
export const PATH_BLOCKED_REASON = firstSentence(ABORT_TEXT.path_blocked);

/** path_blocked when the drone was not landed by the run (a step-by-step run, or no evidence it was flying). */
export const PATH_BLOCKED_NOT_LANDED_TEXT = `${PATH_BLOCKED_REASON} It did not land by itself: land it by hand, then clear the corridor.`;

/**
 * The reason a run stopped, when it is known whether the run sent the drone down where it was (`safe_landing`
 * in the event, or `last_landing === "safe_landing"`). Only path_blocked's words depend on it.
 */
export function abortTextFor(reason: string | null, landed: boolean): string {
  if (reason === "path_blocked" && !landed) return PATH_BLOCKED_NOT_LANDED_TEXT;
  return abortText(reason);
}

/**
 * For a message that already tells the pilot to land it by hand: path_blocked's reason without "landed where it
 * was"; every other reason as abortText.
 */
export function abortReasonOnly(reason: string | null): string {
  return reason === "path_blocked" ? PATH_BLOCKED_REASON : abortText(reason);
}

/** The reason in a `run_aborted` event's detail, with how it ended (`safe_landing`, automatic runs only). */
export function runAbortedText(detail: Record<string, unknown> | null | undefined): string {
  const d = detail ?? {};
  const reason = typeof d.reason === "string" ? d.reason : null;
  return abortTextFor(reason, d.safe_landing === true);
}
