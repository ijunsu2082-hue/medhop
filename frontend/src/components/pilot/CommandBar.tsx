import type { PointerEvent as RPointerEvent, KeyboardEvent as RKeyboardEvent } from "react";
import { useRef } from "react";
import type { Mode } from "../../api/types";
import type { ControlState } from "../../hooks/useControlSocket";
import type { DroneLinkView } from "../../logic/pilot";

interface Props {
  mode: Mode | null;
  control: ControlState;
  /** false when neither the status socket nor the poll reaches the backend */
  backendReachable: boolean;
  onEstop: () => void;
  takeoff: { start: () => void; cancel: () => void; progress: number; holding: boolean };
  /** why takeoff/land cannot be used now (logic/pilot.ts takeoffBlockedReason), or null */
  takeoffBlocked: string | null;
  takeoffNote: { ok: boolean | null; text: string } | null;
  /** backend-to-drone link, shown apart from this browser's control link */
  droneLink: DroneLinkView;
}

const CONTROL_TEXT: Record<ControlState, string> = {
  open: "Control link: connected",
  connecting: "Control link: connecting",
  closed: "Control link: disconnected, reconnecting",
  refused: "Another pilot window is connected. Retrying every 5 s.",
};

export function CommandBar({ mode, control, backendReachable, onEstop, takeoff, takeoffBlocked, takeoffNote, droneLink }: Props) {
  const lastEstop = useRef(0);

  // Fire on pointer-down (fastest), and on click for keyboard activation; de-duplicate the pair.
  const estop = () => {
    const now = performance.now();
    if (now - lastEstop.current < 400) return;
    lastEstop.current = now;
    onEstop();
  };

  const holdDown = (e: RPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    takeoff.start();
  };
  const holdKeyDown = (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter" && !e.repeat) {
      e.preventDefault();
      takeoff.start();
    }
  };
  const holdKeyUp = (e: RKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Enter") takeoff.cancel();
  };

  const controlOpen = control === "open";

  return (
    <section className="command-bar" aria-label="Flight commands">
      <button
        type="button"
        className="estop"
        onPointerDown={estop}
        onClick={estop}
        aria-keyshortcuts="Space"
        aria-describedby="estop-desc"
      >
        <span className="estop-main">EMERGENCY STOP</span>
        <span className="estop-sub" id="estop-desc">
          Sends motor cut: the drone drops. Key: Space
        </span>
      </button>

      <div className="takeoff-wrap">
        <button
          type="button"
          className="takeoff"
          disabled={takeoffBlocked !== null}
          onPointerDown={holdDown}
          onPointerUp={takeoff.cancel}
          onPointerCancel={takeoff.cancel}
          onLostPointerCapture={takeoff.cancel}
          onKeyDown={holdKeyDown}
          onKeyUp={holdKeyUp}
          onBlur={takeoff.cancel}
          onContextMenu={(e) => e.preventDefault()}
          aria-keyshortcuts="T"
          aria-describedby="takeoff-desc"
        >
          <span className="takeoff-fill" style={{ transform: `scaleX(${takeoff.progress})` }} aria-hidden="true" />
          <span className="takeoff-label">Takeoff / Land (toggle)</span>
          <span className="takeoff-sub" id="takeoff-desc">
            {takeoff.holding ? "Keep holding..." : "Press and hold 0.6 s. Key: hold T"}
          </span>
        </button>
        <span className="takeoff-note" role="status">
          {takeoffBlocked ?? takeoffNote?.text ?? ""}
        </span>
      </div>

      <div className="command-status">
        {!backendReachable && (
          <span className="conn conn-fail backend-down" role="alert">
            <span className="conn-dot" aria-hidden="true" />
            <strong>Backend not reachable: controls are not connected</strong>
          </span>
        )}
        {mode === "sim" && <span className="badge badge-sim">Mode: simulator</span>}
        {mode === "real" && <span className="badge badge-real">Mode: real drone</span>}
        <span className={`conn conn-${controlOpen ? "pass" : control === "refused" ? "fail" : "warn"}`} role="status">
          <span className="conn-dot" aria-hidden="true" />
          <span>{CONTROL_TEXT[control]}</span>
        </span>
        {droneLink.link && (
          <span className={`conn conn-${droneLink.link.tone}`} role="status">
            <span className="conn-dot" aria-hidden="true" />
            <span>{droneLink.link.text}</span>
          </span>
        )}
        {droneLink.sticks && (
          <span className="conn conn-warn" role="status">
            <span className="conn-dot" aria-hidden="true" />
            <span>{droneLink.sticks}</span>
          </span>
        )}
      </div>
    </section>
  );
}
