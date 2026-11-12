// Pure Pilot-page decisions (SPEC 10.5): the emergency-stop banner state, takeoff/land availability, matching
// server acks/errors to the command they answer, and the drone-link line. Unit-tested in pilot.test.ts.

import type { ControlServerMessage, MissionAlignment, MissionStatus, Status } from "../api/types";
import { LAST_LANDING_TEXT, abortText, blockerText, controlErrorText } from "../text/wording";

// ---------------------------------------------------------------- emergency stop banner

/** How long a sent stop may wait for the backend (ack or `pilot.estop_active`) before it is shown as not confirmed. */
export const ESTOP_CONFIRM_MS = 500;

export const ESTOP_ADVICE = "If the drone is still flying, keep clear and switch it off by hand when safe.";

export type EstopBannerKind =
  | "unsent" // pressed while the control link was down
  | "sent" // on the socket, waiting up to 500 ms for the backend
  | "not_confirmed" // no ack and no estop_active within 500 ms
  | "unknown" // backend not reachable: the stop state cannot be known
  | "active_sending" // latched, estop_delivered true
  | "active_not_delivered" // latched, estop_delivered false
  | "active_legacy"; // latched, older backend without estop_delivered

export interface EstopInput {
  /** useStatus().reachable */
  reachable: boolean | null;
  /** `pilot.estop_active` from the newest status (also the last known one while unreachable); null: no status yet */
  estopActive: boolean | null;
  /** `pilot.estop_delivered`; undefined from an older backend */
  estopDelivered: boolean | undefined;
  /** this window's last press: sentAt is null when the control link was down and nothing went out */
  pending: { sentAt: number | null } | null;
  /** newest `{"type":"ack","of":"estop"}` with its receive time */
  ack: { at: number; delivered?: boolean } | null;
  now: number;
}

export interface EstopBannerView {
  kind: EstopBannerKind;
  headline: string;
  detail: string;
  /** "Send emergency stop again" */
  retry: boolean;
  /** "Reset emergency stop" */
  reset: boolean;
  dismiss: boolean;
}

/** Which emergency-stop banner to show, or null for none. Never claims the motors are cut. */
export function estopBanner(i: EstopInput): EstopBannerView | null {
  const p = i.pending;
  if (p && p.sentAt === null && !(i.reachable !== false && i.estopActive)) {
    return {
      kind: "unsent",
      headline: "Emergency stop NOT sent: the control link is down.",
      detail: `Use the drone's own controls if you can. ${ESTOP_ADVICE}`,
      retry: true,
      reset: false,
      dismiss: true,
    };
  }

  if (i.reachable === false) {
    if (!p && !i.estopActive) return null;
    return {
      kind: "unknown",
      headline: "Emergency stop state unknown: the backend is not reachable.",
      detail: `This page cannot tell whether the stop reached the drone. ${ESTOP_ADVICE}`,
      retry: true,
      reset: false,
      dismiss: false,
    };
  }

  const ackForPress = p && p.sentAt !== null && i.ack && i.ack.at >= p.sentAt ? i.ack : null;
  const confirmed = i.estopActive === true || ackForPress !== null;
  if (confirmed) {
    // The status flag is the newest word on delivery; the ack's flag covers the moment before status catches up.
    const delivered = i.estopActive === true && i.estopDelivered !== undefined ? i.estopDelivered : ackForPress?.delivered;
    if (delivered === true) {
      return {
        kind: "active_sending",
        headline: "Emergency stop active",
        detail: "Motor-cut command is being sent to the drone. Sticks are held neutral until you reset.",
        retry: false,
        reset: true,
        dismiss: false,
      };
    }
    if (delivered === false) {
      return {
        kind: "active_not_delivered",
        headline: "Emergency stop NOT delivered yet: drone link reconnecting.",
        detail: ESTOP_ADVICE,
        retry: false,
        reset: true,
        dismiss: false,
      };
    }
    return {
      kind: "active_legacy",
      headline: "Emergency stop active: motor-cut command sent.",
      detail: "Sticks are held neutral until you reset.",
      retry: false,
      reset: true,
      dismiss: false,
    };
  }

  if (!p) return null;
  const sentAt = p.sentAt as number;
  if (i.now - sentAt < ESTOP_CONFIRM_MS) {
    return {
      kind: "sent",
      headline: "Emergency stop SENT, not confirmed",
      detail: "Waiting for the backend to confirm.",
      retry: false,
      reset: true,
      dismiss: false,
    };
  }
  return {
    kind: "not_confirmed",
    headline: "Emergency stop NOT confirmed: the backend did not answer within half a second.",
    detail: `Send it again. ${ESTOP_ADVICE}`,
    retry: true,
    reset: true,
    dismiss: false,
  };
}

// ---------------------------------------------------------------- takeoff / land and command notes

/** Why takeoff/land is unavailable right now, or null when it can be used. */
export function takeoffBlockedReason(i: {
  backendReachable: boolean;
  controlOpen: boolean;
  missionState: string | null;
  estopActive?: boolean;
}): string | null {
  if (!i.backendReachable) return "Not available: backend not reachable.";
  if (!i.controlOpen) return "Not available: control link is not connected.";
  // The backend refuses takeoff while emergency stop is latched; say so before the pilot tries.
  if (i.estopActive) return 'Emergency stop is on. Press "Reset emergency stop" first.';
  if (i.missionState === "landing") return "Landing in progress";
  return null;
}

export type PendingCommand = "takeoff_land" | "calibrate";

/** How long the "sent to the drone" note stays up. */
export const ACK_NOTE_MS = 4000;

export const ACK_TEXT: Record<PendingCommand, string> = {
  takeoff_land: "Takeoff/land toggle sent to the drone (the drone does not confirm).",
  calibrate: "Calibrate sent to the drone (the drone does not confirm).",
};

export interface RoutedReply {
  of: PendingCommand;
  ok: boolean;
  text: string;
}

/**
 * Match a server ack/error to the command it answers. `pending` holds the send time of each command still
 * waiting for an answer (null: none waiting). A reply is used only for a command that is waiting and only when
 * it arrived at or after that command was sent; an older reply is ignored. An error without `of` (older backend)
 * goes to the most recently sent waiting command. The caller clears that command once the reply is consumed.
 */
export function routeReply(
  last: { msg: ControlServerMessage; at: number } | null,
  pending: Record<PendingCommand, number | null>,
): RoutedReply | null {
  if (!last) return null;
  const { msg, at } = last;
  let of: PendingCommand | null = null;
  if (msg.type === "ack") {
    if (msg.of === "takeoff_land" || msg.of === "calibrate") of = msg.of;
  } else if (msg.type === "error") {
    if (msg.of === "takeoff_land" || msg.of === "calibrate") of = msg.of;
    else if (msg.of === undefined) {
      const t = pending.takeoff_land;
      const c = pending.calibrate;
      of = t !== null && (c === null || t >= c) ? "takeoff_land" : c !== null ? "calibrate" : null;
    }
  }
  if (of === null) return null;
  const sentAt = pending[of];
  if (sentAt === null || at < sentAt) return null;
  if (msg.type === "ack") return { of, ok: true, text: ACK_TEXT[of] };
  if (msg.type === "error") return { of, ok: false, text: controlErrorText(msg.code, msg.message) };
  return null;
}

// ---------------------------------------------------------------- drone link line

export type Tone = "pass" | "warn" | "fail";

export interface DroneLinkView {
  /** null: an older backend that does not report the drone link (show nothing) */
  link: { tone: Tone; text: string } | null;
  /** shown when the backend holds the sticks neutral because the video is stale */
  sticks: string | null;
}

/** The drone link (backend to drone), shown apart from the browser's control link (browser to backend). */
export function droneLinkView(s: Pick<Status, "mode" | "link"> | null): DroneLinkView {
  if (!s) return { link: null, sticks: null };
  const sticks =
    s.link.sticks_blocked === true
      ? "Video is stale: sticks are held neutral until it returns. Emergency stop and takeoff/land still work."
      : null;
  if (s.mode === "sim") return { link: { tone: "pass", text: "Simulator (no real drone)" }, sticks };
  const { control_up, drone_seen } = s.link;
  let link: DroneLinkView["link"] = null;
  if (control_up === false) link = { tone: "fail", text: "Drone link: reconnecting. Commands are not reaching the drone." };
  else if (drone_seen === false) link = { tone: "warn", text: "No reply from the drone yet. Is this laptop on the drone's Wi-Fi?" };
  else if (control_up === true && drone_seen === true) link = { tone: "pass", text: "Drone link: connected" };
  return { link, sticks };
}

// ---------------------------------------------------------------- end-of-run message

/** The "done" line on the Pilot page from `mission.last_landing`. null, missing (older backend) or an unknown value
 * cannot say whether the landing command went out, so the pilot is told to check and land by hand. */
export function doneMessage(lastLanding: string | null | undefined): string {
  switch (lastLanding) {
    case "sent":
      return LAST_LANDING_TEXT.sent;
    case "skipped_settle_guard_undecided":
      return LAST_LANDING_TEXT.skipped_settle_guard_undecided;
    case "refused_by_mixer":
      return LAST_LANDING_TEXT.refused_by_mixer;
    case "off":
      return LAST_LANDING_TEXT.off;
    default:
      return LAST_LANDING_TEXT.unknown;
  }
}

// ---------------------------------------------------------------- automatic station run

/** The six stages of an automatic run, in order. */
export const AUTO_STAGES = ["Take off", "Find the sign", "Fly to the sign", "Line up", "Land", "At the station"] as const;

/** Mission states during which a station run is in progress (automatic or step by step). */
export const RUN_ACTIVE_STATES: ReadonlySet<string> = new Set([
  "countdown",
  "taking_off",
  "searching",
  "approaching",
  "aligning",
  "arrived",
  "landing",
]);

/** Which of AUTO_STAGES a mission state belongs to, or -1 for a state outside a run (idle, aborted, unknown). */
export function autoStageIndex(state: string): number {
  switch (state) {
    case "countdown":
    case "taking_off":
      return 0;
    case "searching":
      return 1;
    case "approaching":
      return 2;
    case "aligning":
      return 3;
    case "arrived":
    case "landing":
      return 4;
    case "done":
      return 5;
    default:
      return -1;
  }
}

/** True when the backend sends the automatic-run fields (an older backend does not). */
export function autoSupported(m: MissionStatus): boolean {
  return typeof m.can_start_auto === "boolean" && Array.isArray(m.auto_blockers);
}

/** Metres to one decimal ("0.8"), or null for a missing, negative or non-finite value. */
export function formatMetres(x: unknown): string | null {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) return null;
  return x.toFixed(1);
}

/** "Sign about 1.9 m away. It lands at about 0.8 m." The first half is left out while the sign is not in view. */
export function autoDistanceLine(distance: number | null | undefined, arrive: number | null | undefined): string | null {
  const d = formatMetres(distance);
  const a = formatMetres(arrive);
  const parts: string[] = [];
  if (d !== null) parts.push(`Sign about ${d} m away.`);
  if (a !== null) parts.push(`It lands at about ${a} m.`);
  return parts.length ? parts.join(" ") : null;
}

function finiteNumber(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/**
 * "4 cm left of the centre line" from an offset in metres (+ = right of the sign's centre line, as seen facing
 * the sign), "on the centre line" under 0.5 cm, or null for a missing or non-finite value.
 */
export function lateralText(lateral: unknown): string | null {
  const x = finiteNumber(lateral);
  if (x === null) return null;
  const cm = Math.round(Math.abs(x) * 100);
  if (Math.abs(x) < 0.005 || cm === 0) return "on the centre line";
  return `${cm} cm ${x > 0 ? "right" : "left"} of the centre line`;
}

/** Metres to two decimals ("0.81"), or null for a missing, negative or non-finite value. */
function metres2(x: unknown): string | null {
  const v = finiteNumber(x);
  return v === null || v < 0 ? null : v.toFixed(2);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The live line while "aligning": "4 cm left of the centre line, 0.81 m from the sign. Holding still 0.6 of 1.0 s."
 * Parts whose value is missing are left out; null when nothing is left.
 */
export function alignmentLine(a: MissionAlignment | null | undefined): string | null {
  if (!a) return null;
  const first: string[] = [];
  const lat = lateralText(a.lateral_m);
  if (lat !== null) first.push(lat);
  const d = metres2(a.distance_m);
  if (d !== null) first.push(`${d} m from the sign`);
  const sentences: string[] = [];
  if (first.length) sentences.push(`${capitalise(first.join(", "))}.`);
  const held = finiteNumber(a.aligned_for_s);
  const need = finiteNumber(a.need_s);
  if (held !== null && need !== null) sentences.push(`Holding still ${Math.max(0, held).toFixed(1)} of ${need.toFixed(1)} s.`);
  return sentences.length ? sentences.join(" ") : null;
}

/** "Taking off in 3" during the countdown (whole seconds, rounded up), else null. */
export function countdownText(state: string, remaining: number | null | undefined): string | null {
  if (state !== "countdown") return null;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return "Taking off in a few seconds";
  return `Taking off in ${Math.max(0, Math.ceil(remaining))}`;
}

export const AUTO_CONTROL_LINK_BLOCKER = "Your control link is not connected, so you could not take over or stop.";
export const AUTO_BACKEND_REFUSES = "The backend reports it cannot start a run right now.";

/** The "Before it can fly:" list for an automatic start. Empty while a run is in progress. */
export function autoBlockerTexts(m: MissionStatus, controlOpen: boolean): string[] {
  if (RUN_ACTIVE_STATES.has(m.state)) return [];
  const out = (m.auto_blockers ?? []).map((c) => blockerText(String(c)));
  if (m.can_start_auto === false && out.length === 0) out.push(AUTO_BACKEND_REFUSES);
  if (!controlOpen) out.push(AUTO_CONTROL_LINK_BLOCKER);
  return out;
}

/** "The station sign was lost ... again." -> "the station sign was lost ... again", to follow "Stopped early: ". */
function asClause(sentence: string): string {
  const t = sentence.trim().replace(/\.$/, "");
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

function firstSentence(text: string): string {
  const match = text.trim().match(/^[^.]*\./);
  return match ? match[0] : text;
}

export interface AutoResultView {
  tone: "pass" | "warn";
  text: string;
}

/** The result card after an automatic run, or null when the last run was not automatic or has not ended. */
export function autoResultView(m: MissionStatus): AutoResultView | null {
  if (m.automatic !== true) return null;
  if (m.state === "done") {
    if (m.last_landing !== "sent") return { tone: "warn", text: doneMessage(m.last_landing) };
    const arrival = m.last_arrival;
    if (arrival) {
      const parts: string[] = [];
      const d = metres2(arrival.distance_m);
      if (d !== null) parts.push(`about ${d} m from the sign`);
      const lat = lateralText(arrival.lateral_offset_m);
      if (lat !== null) parts.push(lat);
      const where = parts.length ? `At the station: ${parts.join(", ")}.` : "At the station.";
      const notAligned = arrival.aligned === false ? " It could not line up exactly." : "";
      return { tone: "pass", text: `${where} The land command was sent: check that it has landed.${notAligned}` };
    }
    const a = formatMetres(m.arrive_distance_m);
    return {
      tone: "pass",
      text: a !== null
        ? `At the station, about ${a} m in front of the sign. The land command was sent: check that it has landed.`
        : "At the station, in front of the sign. The land command was sent: check that it has landed.",
    };
  }
  if (m.state === "aborted") {
    const reason = asClause(abortText(m.reason));
    if (m.last_landing === "safe_landing") {
      // Only the reason's first sentence: some reasons go on with "land by hand", which no longer applies.
      return { tone: "warn", text: `Stopped early: ${asClause(firstSentence(abortText(m.reason)))}. The land command was sent where it was: check that it has landed.` };
    }
    return {
      tone: "warn",
      text: `Stopped early: ${reason}. If it is still in the air, land it with T or the emergency stop.`,
    };
  }
  return null;
}

export const NEEDS_PILOT_TEXT = "The drone may still be in the air. Land it with T or press the emergency stop.";

/** Under the "Fly automatically" switch: whether the drone is marked ready for the next scheduled flight. */
export function autoReadyView(m: MissionStatus): { ready: boolean; text: string } | null {
  if (m.auto_fly !== true || typeof m.ready_for_dose !== "boolean") return null;
  return m.ready_for_dose
    ? { ready: true, text: "Ready. It will take off by itself when the next dose is due." }
    : { ready: false, text: "Before the next dose: put the drone on its start spot facing the sign, then press" };
}

/** The "Where does it land?" explainer, with the backend's arrival distance when it sends one. */
export function landingExplainerText(arrive: number | null | undefined): string {
  const a = formatMetres(arrive) ?? "0.8";
  return (
    "It only lands when the sign fills enough of the camera view, sits in the middle of the picture and is seen " +
    "from the front, three frames in a row, after the drone has clearly flown toward it. " +
    `That is about ${a} m in front of the sign (it can settle a little closer): put the landing spot there. ` +
    "A sign farther than about 5 m is too small to count, and signs with another number are ignored."
  );
}

// ---------------------------------------------------------------- run mode (Automatic / Step by step)

export type RunMode = "auto" | "steps";
export const RUN_MODE_KEY = "medhop.runMode";

/** A stored run mode, defaulting to Automatic for anything missing or unknown. */
export function parseRunMode(v: string | null | undefined): RunMode {
  return v === "steps" ? "steps" : "auto";
}
