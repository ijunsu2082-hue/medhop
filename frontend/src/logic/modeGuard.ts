// The mode guard: the backend's reported mode ("sim" or "real") may not change while one page is open.
//
// Which backend a page talks to is fixed when the site is built, but in a Python build the backend itself can be
// restarted in the other mode behind an open page. A page that was flying the real drone would then quietly be
// flying a simulator (and a page opened for the simulator would be flying the real drone). So the first mode the
// page sees is pinned; once a later status reports the other mode, the guard trips and stays tripped until the
// page is reloaded, even if the mode changes back. The Pilot page then shows a blocking banner and closes its
// control link (pages/PilotPage.tsx).
//
// Pure and without React, so it can be tested on its own (modeGuard.test.ts). hooks/useStatus.tsx feeds it every
// status for the whole life of the page, on every route.

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
 * The guard after one status reporting `mode`. Returns `state` itself when nothing changes, so it can feed a React
 * state setter without a re-render on every status. A missing or unknown mode is ignored.
 */
export function observeMode(state: ModeGuardState, mode: unknown): ModeGuardState {
  if (state.change !== null || !isMode(mode)) return state;
  if (state.pinned === null) return { pinned: mode, change: null };
  if (mode === state.pinned) return state;
  return { pinned: state.pinned, change: { from: state.pinned, to: mode } };
}
