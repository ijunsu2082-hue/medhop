// Pure Pilot-page decisions (SPEC 10.5): the emergency-stop banner state, takeoff/land availability, matching
// server acks/errors to the command they answer, and the drone-link line. Unit-tested in pilot.test.ts.

import type { ControlServerMessage, Status } from "../api/types";
import { LAST_LANDING_TEXT, controlErrorText } from "../text/wording";

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
export function takeoffBlockedReason(i: { backendReachable: boolean; controlOpen: boolean; missionState: string | null }): string | null {
  if (!i.backendReachable) return "Not available: backend not reachable.";
  if (!i.controlOpen) return "Not available: control link is not connected.";
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
