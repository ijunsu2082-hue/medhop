// The mode guard: the backend's reported mode ("sim" or "real") may not change while one page is open.
//
// Which backend a page talks to is fixed when the site is built, but in a Python build the backend itself can be
// restarted in the other mode behind an open page. A page that was flying the real drone would then quietly be
// flying a simulator, and a page opened for the simulator would be flying the real drone. So the first mode the
// page sees is pinned; once a later status reports the other mode, the guard trips and stays tripped until the
// page is reloaded, even if the mode changes back.
//
// A tripped guard locks the controls but never the emergency stop: the control link stays connected, and of
// everything the page sends only the emergency stop gets through. That matters most in the dangerous direction, a
// page opened for the simulator whose backend now flies the real drone. Two choke points enforce it, both reading
// this page's latch (pageModeChange), which hooks/useStatus.tsx updates synchronously with every status:
// - control messages: guardedControlSend, the send path of hooks/useControlSocket.ts;
// - REST requests: requestRefusal, checked by api/client.ts before any request leaves the page. GET requests and
//   POST /api/mission/abort (it only ever stops a run) still go out; everything else is refused locally.
//
// Everything here except the latch is pure (modeGuard.test.ts).

import type { ControlMessage } from "../api/types";
import { REQUEST_LOCKED_TEXT, controlLockedText } from "../text/pilotWording";

export type BackendMode = "sim" | "real";

export interface ModeChange {
  /** The mode the page first saw. */
  from: BackendMode;
  /** The different mode a later status reported. */
  to: BackendMode;
}

export interface ModeGuardState {
  /** The first mode seen, or null before any status. */
  readonly pinned: BackendMode | null;
  /** The change that tripped the guard, or null while the mode has not changed. */
  readonly change: ModeChange | null;
}

export const MODE_GUARD_START: ModeGuardState = Object.freeze({ pinned: null, change: null });

const isMode = (m: unknown): m is BackendMode => m === "sim" || m === "real";

/**
 * The guard after one status reporting `mode`. Returns `state` itself when nothing changes. A missing or unknown
 * mode is ignored.
 */
export function observeMode(state: ModeGuardState, mode: unknown): ModeGuardState {
  if (state.change !== null || !isMode(mode)) return state;
  if (state.pinned === null) return { pinned: mode, change: null };
  if (mode === state.pinned) return state;
  return { pinned: state.pinned, change: { from: state.pinned, to: mode } };
}

// ---------------------------------------------------------------------------------------------------- the latch

// This page's guard. It lives as long as the document: only a reload clears it, and nothing here resets it.
let pageGuard: ModeGuardState = MODE_GUARD_START;

/** Feed one status's mode to this page's guard. Returns the change that tripped it, or null. */
export function observePageMode(mode: unknown): ModeChange | null {
  pageGuard = observeMode(pageGuard, mode);
  return pageGuard.change;
}

/** The change that tripped this page's guard, or null while it has not tripped. */
export function pageModeChange(): ModeChange | null {
  return pageGuard.change;
}

// ----------------------------------------------------------------------------------------------- the choke points

/** Why `msg` may not be sent, or null when it may. Once tripped, only the emergency stop may. */
export function controlRefusal(msg: Pick<ControlMessage, "type">, change: ModeChange | null): string | null {
  if (change === null || msg.type === "estop") return null;
  return controlLockedText(msg.type);
}

/** An all-zero axes message: the page letting go of the sticks (key up, window blur, release on lock). */
const isStickRelease = (msg: ControlMessage) =>
  msg.type === "axes" && msg.throttle === 0 && msg.yaw === 0 && msg.pitch === 0 && msg.roll === 0;

/**
 * The page's control send path with the guard in front of it. `change` is read on every message (pass
 * pageModeChange); a refused message never reaches `send` and makes this return false. Its reason goes to
 * `onRefused`, except for a stick release, which the pilot did not ask for (the backend's deadman sets the sticks
 * to neutral 0.4 s after the last non-zero stick message, so nothing stays held).
 */
export function guardedControlSend(
  send: (msg: ControlMessage) => boolean,
  change: () => ModeChange | null,
  onRefused: (reason: string) => void,
): (msg: ControlMessage) => boolean {
  return (msg) => {
    const reason = controlRefusal(msg, change());
    if (reason !== null) {
      if (!isStickRelease(msg)) onRefused(reason);
      return false;
    }
    return send(msg);
  };
}

/** The one mutating request a tripped guard still lets out: it only ever stops a run. */
export const ABORT_PATH = "/api/mission/abort";

/** Why a request may not leave this page, or null when it may. Once tripped, only GETs and the abort may. */
export function requestRefusal(method: string, path: string, change: ModeChange | null): string | null {
  if (change === null) return null;
  const m = method.toUpperCase();
  if (m === "GET") return null;
  if (m === "POST" && path.split("?")[0] === ABORT_PATH) return null;
  return REQUEST_LOCKED_TEXT;
}
