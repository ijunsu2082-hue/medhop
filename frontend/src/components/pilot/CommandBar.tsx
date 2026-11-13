import { useRef, type ReactNode } from "react";
import type { Mode } from "../../api/types";
import type { ControlState } from "../../hooks/useControlSocket";
import type { DroneLinkView } from "../../logic/pilot";
import { withoutLegend, type RailTone } from "../../text/pilotWording";
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
  /** the video value (text/pilotWording.ts videoRailValue) and its tone, the same value as under the camera */
  video: { value: string; tone: RailTone };
}

// "refused" is explained once, in the banner under this strip (PilotPage).
const CONTROL_TEXT: Record<ControlState, string> = {
  open: "Control link: connected",
  connecting: "Control link: connecting",
  closed: "Control link: disconnected, reconnecting",
  refused: "Control link: refused",
};

function Item({ legend, tone, children }: { legend: string; tone: RailTone; children: ReactNode }) {
  return (
    <li>
      <span className="readout-k" aria-hidden="true">
        {legend}
      </span>
      <span className={`state tone-${tone}`}>
        <span className="dot" aria-hidden="true" />
        {children}
      </span>
    </li>
  );
}

/** The strip at the top of the Pilot page: the emergency stop first, then takeoff / land and the links. */
export function CommandBar({
  mode,
  control,
  backendReachable,
  onEstop,
  takeoff,
  takeoffBlocked,
  takeoffNote,
  droneLink,
  video,
}: Props) {
  const lastEstop = useRef(0);

  // Fire on pointer-down (fastest), and on click for keyboard activation; de-duplicate the pair.
  const estop = () => {
    const now = performance.now();
    if (now - lastEstop.current < 400) return;
    lastEstop.current = now;
    onEstop();
  };

  // Short copy of the step 1 live line; the announced one is in step 1.
  const note = takeoffBlocked ?? takeoffNote?.text ?? "";
  const controlTone: RailTone = control === "open" ? "pass" : control === "refused" ? "fail" : "warn";

  return (
    <section className="command-bar container" aria-label="Flight commands">
      <button
        type="button"
        className="estop"
        onPointerDown={estop}
        onClick={estop}
        aria-keyshortcuts="Space"
        aria-describedby="estop-desc"
      >
        <span className="estop-main">Emergency stop</span>
        <span className="estop-sub" id="estop-desc">
          Sends motor cut. The drone drops.<span className="sr-only"> Key: Space</span>
        </span>
        <kbd className="estop-key" aria-hidden="true">
          Space
        </kbd>
      </button>

      <HoldButton
        hold={takeoff}
        disabled={takeoffBlocked !== null}
        label={
          <>
            Takeoff / Land <span className="takeoff-paren">(toggle)</span>
          </>
        }
        sub="Press and hold for 0.6 s"
        subId="takeoff-desc"
        keyShortcut="T"
        className="takeoff-compact"
      />

      <div className="strip-status">
        {mode === "real" && <p className="strip-real">Real drone</p>}
        <ul className="readout">
          <Item legend="Control link" tone={controlTone}>
            <span role="status">
              <span aria-hidden="true">{withoutLegend(CONTROL_TEXT[control], "Control link:")}</span>
              <span className="sr-only">{CONTROL_TEXT[control]}</span>
            </span>
          </Item>
          {/* In the simulator the drone link only says "Simulator": the masthead already names the mode. */}
          {mode === "real" && droneLink.link && (
            <Item legend="Drone link" tone={droneLink.link.tone}>
              <span role="status">
                <span aria-hidden="true">{withoutLegend(droneLink.link.text, "Drone link:")}</span>
                <span className="sr-only">{droneLink.link.text}</span>
              </span>
            </Item>
          )}
          {backendReachable && (
            <Item legend="Video" tone={video.tone}>
              <span>
                <span className="sr-only">Video: </span>
                {video.value}
              </span>
            </Item>
          )}
        </ul>
        {droneLink.sticks && (
          <p className="strip-sticks state tone-warn" role="status">
            <span className="dot" aria-hidden="true" />
            <span>{droneLink.sticks}</span>
          </p>
        )}
        <p className="takeoff-note" aria-hidden="true">
          {note}
        </p>
      </div>
    </section>
  );
}
