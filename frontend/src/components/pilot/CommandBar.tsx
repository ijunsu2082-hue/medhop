import { useRef } from "react";
import type { Mode } from "../../api/types";
import type { ControlState } from "../../hooks/useControlSocket";
import type { DroneLinkView } from "../../logic/pilot";
import { HoldButton, type Hold } from "./HoldButton";

interface Props {
  mode: Mode | null;
  control: ControlState;
  /** false when neither the status socket nor the poll reaches the backend */
  backendReachable: boolean;
  onEstop: () => void;
  takeoff: Hold;
  /** why takeoff/land cannot be used now (logic/pilot.ts takeoffBlockedReason), or null */
  takeoffBlocked: string | null;
  takeoffNote: { ok: boolean | null; text: string } | null;
  /** backend-to-drone link, shown apart from this browser's control link */
  droneLink: DroneLinkView;
}

// "refused" is explained once, in the banner under this bar (PilotPage).
const CONTROL_TEXT: Record<ControlState, string> = {
  open: "Control link: connected",
  connecting: "Control link: connecting",
  closed: "Control link: disconnected, reconnecting",
  refused: "Control link: refused",
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

  const controlOpen = control === "open";
  // Short copy of the step 1 live line; the announced one is in step 1.
  const note = takeoffBlocked ?? takeoffNote?.text ?? "";

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
        <HoldButton
          hold={takeoff}
          disabled={takeoffBlocked !== null}
          label="Takeoff / Land (toggle)"
          sub="Press and hold 0.6 s. Key: hold T"
          subId="takeoff-desc"
          keyShortcut="T"
          className="takeoff-compact"
        />
        <span className="takeoff-note" aria-hidden="true" title={note || undefined}>
          {note}
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
