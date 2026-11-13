// The landing page's demo, as plain functions: which step a run is on, the one sentence that says what is
// happening, the calls that start a run, and how a stopped run is brought down. components/landing/LandingDemo.tsx
// only draws what these return, so the whole flow is tested here without a browser (demo.test.ts).

import type { ControlServerMessage, DoseToday, ScheduleDose, ScheduleResponse, SimPose, Status } from "../api/types";
import { abortTextFor, avoidLine, obstacleNoun } from "../text/avoidWording";
import { MISSION_STATE_TEXT, doseStatusLine, missionStateText } from "../text/wording";
import { arrivalLine } from "./care";
import { countdownText } from "./pilot";

/** One call to the API. Rejects with an ApiError for an answer outside 200-299 (api/client.ts requestVia). */
export type DemoCall = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export const RUN_ACTIVE: ReadonlySet<string> = new Set([
  "countdown",
  "taking_off",
  "searching",
  "approaching",
  "aligning",
  "arrived",
  "landing",
]);

// The steps the page lists (landingWording.ts DEMO.steps): dose is due, count down, take off, find the sign,
// fly to it, line up, land.
const STEP_OF: Record<string, number> = {
  countdown: 1,
  taking_off: 2,
  searching: 3,
  approaching: 4,
  aligning: 5,
  arrived: 6,
  landing: 6,
};

/** Which listed step a mission state belongs to; null for a state that is not part of a run. */
export function stepOf(state: string): number | null {
  return Object.prototype.hasOwnProperty.call(STEP_OF, state) ? STEP_OF[state]! : null;
}

/**
 * Where the demo is.
 * - idle: nothing started from this page yet.
 * - running: a run is in progress (or was accepted a moment ago and the status has not caught up).
 * - arrived: the run ended at the station; the person has not said they picked it up.
 * - acknowledged: they have.
 * - stopped: the run ended early.
 */
export type DemoPhase = "idle" | "running" | "arrived" | "acknowledged" | "stopped";

/** `runId`: the run this page started, null when it has started none. */
export function demoPhase(status: Status, runId: string | null, dose: DoseToday | null): DemoPhase {
  const m = status.mission;
  if (RUN_ACTIVE.has(m.state)) return "running";
  if (runId === null) return "idle";
  if (m.run_id !== runId) return "running";
  if (m.state === "done") return dose?.status === "acknowledged" ? "acknowledged" : "arrived";
  if (m.state === "aborted") return "stopped";
  return "idle";
}

export type StepState = "todo" | "now" | "done";

/** `furthest`: the highest step this run reached, for a run that stopped early. */
export function stepStates(count: number, phase: DemoPhase, state: string, furthest: number | null): StepState[] {
  const now = phase === "running" ? (stepOf(state) ?? 0) : null;
  return Array.from({ length: count }, (_, i): StepState => {
    if (phase === "arrived" || phase === "acknowledged") return "done";
    if (now !== null) return i < now ? "done" : i === now ? "now" : "todo";
    if (phase === "stopped" && furthest !== null) return i < furthest ? "done" : "todo";
    return "todo";
  });
}

export interface DemoLine {
  /**
   * "wait": the drone is waiting for something in its way, or the run ended because the way stayed blocked (amber).
   * "warn": any other ending that needs reading (ink, hollow mark). "pass": arrived or picked up. "info": the rest.
   */
  tone: "pass" | "warn" | "wait" | "info";
  text: string;
  /**
   * The same thing for a screen reader's live region, without the parts that change several times a second (a
   * distance, the seconds of the countdown): it is read out once per change, not once per status.
   */
  announce: string;
}

const say = (tone: DemoLine["tone"], text: string, announce = text): DemoLine => ({ tone, text, announce });

/** The dose this page's run is for, as today's list has it. */
export function demoDose(status: Status, doseId: string | null): DoseToday | null {
  return doseId === null ? null : (status.care.doses.find((d) => d.id === doseId) ?? null);
}

/**
 * One sentence about what is happening now, or null when there is nothing to say. `stop`: the visitor pressed
 * Stop on this page, so the reason is theirs and is not spelled out; "landing" while the drone is coming down.
 */
export function demoLine(
  status: Status,
  phase: DemoPhase,
  dose: DoseToday | null,
  stop: "no" | "landing" | "landed" = "no",
): DemoLine | null {
  const m = status.mission;
  if (phase === "running") {
    // Accepted a moment ago: the status still describes the run before this one.
    if (!RUN_ACTIVE.has(m.state)) return say("info", "Starting");
    const counting = countdownText(m.state, m.countdown_remaining_s);
    if (counting !== null) return say("info", counting, MISSION_STATE_TEXT.countdown);
    const waiting = m.avoid && m.avoid.state !== "clear" ? avoidLine(m.avoid) : null;
    if (waiting) {
      const what = obstacleNoun(m.avoid?.kind);
      const coarse =
        m.avoid?.state === "slow" ? `Slowing: ${what} ahead` : m.avoid?.state === "hold" ? `Waiting: ${what} in the way` : waiting.text;
      return say("wait", waiting.text, coarse);
    }
    return say("info", missionStateText(m.state));
  }
  if (phase === "arrived") {
    const arrival = dose ? arrivalLine(dose) : null;
    return say("pass", arrival ? `${arrival}.` : "Arrived at station.");
  }
  if (phase === "acknowledged" && dose) return say("pass", `${doseStatusLine(dose)}.`);
  if (phase === "stopped") {
    if (stop !== "no") return say("info", stop === "landing" ? "Stopped. The simulated drone is landing." : "Stopped.");
    // Only the blocked ending is about waiting; the 45 s limit, a lost sign and the rest read as a plain notice.
    return say(m.reason === "path_blocked" ? "wait" : "warn", abortTextFor(m.reason, m.last_landing === "safe_landing"));
  }
  return null;
}

/** The simulated drone is down. Its `airborne` is false while it climbs and while it comes down, so the height counts too. */
export function onGround(pose: SimPose | null | undefined): boolean {
  return !pose || (pose.airborne !== true && pose.altitude_m < 0.02);
}

// ---------------------------------------------------------------- starting a run

/**
 * False for the few seconds after a landing in which the backend refuses a new takeoff (blocker recent_toggle),
 * and while the drone is still in the air. The page keeps its Run button off meanwhile instead of offering a
 * press that would be refused. Other blockers are left to the start call, which says what they are.
 */
export function readyToRun(status: Status): boolean {
  if (!onGround(status.sim?.pose)) return false;
  return !(status.mission.auto_blockers ?? []).includes("recent_toggle");
}

/**
 * Start one automatic run for a dose that is due now.
 * 1. Set the corridor again, to the one the backend has now. This carries a landed drone back to its start spot.
 *    The corridor and the time are asked for here, not taken from the page's last status (up to 200 ms old): the
 *    visitor may have changed the corridor a moment ago.
 * 2. Remove the dose an earlier demo run left behind, and add one due at this minute.
 * 3. Start the run for it. When the start is refused (a 409 with blockers), the dose is taken out again and the
 *    refusal is thrown on, so the page can say why.
 */
export async function startDemoRun(call: DemoCall, label: string): Promise<{ runId: string; doseId: string }> {
  const fresh = await call<Status>("GET", "/api/status");
  const nowLocal = fresh.care.now_local;
  await call("POST", "/api/sim/scenario", { name: fresh.sim?.scenario ?? "empty" });
  const schedule = await call<ScheduleResponse>("GET", "/api/schedule");
  for (const old of schedule.doses) {
    if (old.label === label) await call("DELETE", `/api/schedule/${encodeURIComponent(old.id)}`);
  }
  const dose = await call<ScheduleDose>("POST", "/api/schedule", { time: nowLocal, label, notes: "" });
  try {
    const started = await call<{ run_id: string }>("POST", "/api/mission/start", { automatic: true, dose_id: dose.id });
    return { runId: started.run_id, doseId: dose.id };
  } catch (refusal) {
    await call("DELETE", `/api/schedule/${encodeURIComponent(dose.id)}`).catch(() => undefined);
    throw refusal;
  }
}

// ---------------------------------------------------------------- stopping a run

/** What the control link last said about a takeoff/land press, or null when the message is about something else. */
export function landReply(message: { msg: ControlServerMessage; at: number } | null): { at: number; ok: boolean } | null {
  if (!message) return null;
  const { msg, at } = message;
  if (msg.type === "ack" && msg.of === "takeoff_land") return { at, ok: true };
  if (msg.type === "error" && msg.of === "takeoff_land") return { at, ok: false };
  return null;
}

export const LAND_RETRY_MS = 1000;
/** The drone counts as landed once it has been on the ground this long: right after a takeoff it has not left it yet. */
export const GROUND_SETTLE_MS = 1000;
/** An accepted landing that has not started the descent after this long did not take: it is sent again. */
export const LAND_AGAIN_MS = 3000;

/**
 * How long a drone must have been seen in steady flight with no run in progress before this page lands it, when
 * the visitor did not press Stop. A run that ends at the station sends its own landing command: this gives that
 * a moment to show.
 */
export const LAND_GRACE_MS = 1500;

/**
 * No run is in progress and the drone may be up: after Stop, after a run that ended without landing, or because
 * the visitor left this page in the middle of a run (the run then stops, and early in a flight it does not land
 * by itself). The demo needs the drone on the ground, so this page lands it.
 *
 * The landing command is the same toggle as takeoff, so it is sent only while the drone is in steady flight
 * (`flying`): never while it is still climbing or already coming down, when a press would do the wrong thing.
 * Once accepted it is not sent again unless the drone is plainly still flying seconds later. A refusal (the
 * backend guards a toggle for a moment after a takeoff) is retried after a pause.
 */
export function landAction(input: {
  /** in steady flight: the simulator's `airborne` */
  flying: boolean;
  /** on the ground (onGround) */
  grounded: boolean;
  /** how long it has been on the ground, in ms (0 when it is not) */
  groundedFor: number;
  /** how long it has been in steady flight with no run in progress, in ms (0 when it is not) */
  flyingFor: number;
  /** how long that must be before the first press: 0 after Stop, else LAND_GRACE_MS */
  graceMs: number;
  /** when this page last sent the toggle (same clock as `reply.at`); null: not yet */
  sentAt: number | null;
  reply: { at: number; ok: boolean } | null;
  now: number;
}): "send" | "wait" | "landed" {
  if (input.grounded) return input.groundedFor >= GROUND_SETTLE_MS ? "landed" : "wait";
  if (!input.flying) return "wait";
  if (input.sentAt === null) return input.flyingFor >= input.graceMs ? "send" : "wait";
  const reply = input.reply && input.reply.at >= input.sentAt ? input.reply : null;
  if (reply && !reply.ok && input.now - reply.at >= LAND_RETRY_MS) return "send";
  if (reply && reply.ok && input.now - reply.at >= LAND_AGAIN_MS) return "send";
  return "wait";
}
