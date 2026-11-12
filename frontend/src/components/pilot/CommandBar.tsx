import { useRef } from "react";
import type { Mode } from "../../api/types";
import type { ControlState } from "../../hooks/useControlSocket";
import type { DroneLinkView } from "../../logic/pilot";
import { withoutLegend, type RailTone } from "../../text/pilotWording";
import { IconLock, IconStop } from "../Icons";
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
  /** the VIDEO readout (text/pilotWording.ts videoRailValue) and its tone, the same value as the camera rail */
  video: { value: string; tone: RailTone };
}

// "refused" is explained once, in the banner under this bar (PilotPage).
const CONTROL_TEXT: Record<ControlState, string> = {
  open: "Control link: connected",
  connecting: "Control link: connecting",
  closed: "Control link: disconnected, reconnecting",
  refused: "Control link: refused",
};

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

  const controlOpen = control === "open";
  // Short copy of the step 1 live line; the announced one is in step 1.
  const note = takeoffBlocked ?? takeoffNote?.text ?? "";

  const controlTone = controlOpen ? "pass" : control === "refused" ? "fail" : "warn";
  // In simulator mode the DRONE row repeats the MODE stamp; on a phone it is left to assistive tech.
  const droneRedundant = mode === "sim" && droneLink.link?.tone === "pass";
  // With the backend down the alert below says so once: the reason beside takeoff and the VIDEO row are not drawn.
  const barClass = `command-bar${mode === "real" ? " command-bar--real" : ""}${backendReachable ? "" : " command-bar--down"}`;

  return (
    <section className={barClass} aria-label="Flight commands">
      <button
        type="button"
        className="estop"
        onPointerDown={estop}
        onClick={estop}
        aria-keyshortcuts="Space"
        aria-describedby="estop-desc"
      >
        <IconStop className="estop-icon" size={30} />
        <span className="estop-main">EMERGENCY STOP</span>
        <span className="estop-sub" id="estop-desc">
          Sends motor cut. The drone drops.<span className="sr-only"> Key: Space</span>
        </span>
        <kbd className="estop-key" aria-hidden="true">
          Space
        </kbd>
      </button>

      <div className="takeoff-wrap">
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
        <span className={`takeoff-note${takeoffBlocked !== null ? " takeoff-note--blocked" : ""}`} aria-hidden="true">
          {takeoffBlocked !== null && <IconLock className="takeoff-note-icon" size={16} />}
          {note}
        </span>
      </div>

      <div className="command-status">
        {!backendReachable && (
          <p className="command-down tone-fail backend-down" role="alert">
            <span className="status-sq" aria-hidden="true" />
            <strong>Backend not reachable: controls are not connected</strong>
          </p>
        )}
        <div className="readout">
          {mode && (
            <div className="readout-row readout-mode">
              <span className="readout-legend readout-legend--mode" aria-hidden="true">
                Mode
              </span>
              <span className="readout-data">
                {mode === "sim" ? (
                  <span className="stamp" aria-hidden="true">
                    Simulator
                  </span>
                ) : (
                  <span className="stamp stamp--amber" aria-hidden="true">
                    Real drone
                  </span>
                )}
                <span className="sr-only">{mode === "sim" ? "Mode: simulator" : "Mode: real drone"}</span>
              </span>
            </div>
          )}
          <div className="readout-row">
            {/* "Control" on a phone, "Control link" elsewhere: every value keeps its noun. */}
            <span className="readout-legend" aria-hidden="true">
              Control<span className="readout-legend-more"> link</span>
            </span>
            <span className="readout-data">
              <span className={`readout-value tone-${controlTone}`} role="status">
                <span className="status-sq" aria-hidden="true" />
                <span aria-hidden="true">{withoutLegend(CONTROL_TEXT[control], "Control link:")}</span>
                <span className="sr-only">{CONTROL_TEXT[control]}</span>
              </span>
            </span>
          </div>
          {droneLink.link && (
            <div className={`readout-row${droneRedundant ? " readout-row--redundant" : ""}`}>
              <span className="readout-legend" aria-hidden="true">Drone</span>
              <span className="readout-data">
                <span className={`readout-value tone-${droneLink.link.tone}`} role="status">
                  <span className="status-sq" aria-hidden="true" />
                  <span aria-hidden="true">{withoutLegend(droneLink.link.text, "Drone link:")}</span>
                  <span className="sr-only">{droneLink.link.text}</span>
                </span>
              </span>
            </div>
          )}
          {droneLink.sticks && (
            <div className="readout-row">
              <span className="readout-legend" aria-hidden="true">Sticks</span>
              <span className="readout-data">
                <span className="readout-value tone-warn" role="status">
                  <span className="status-sq" aria-hidden="true" />
                  <span>{droneLink.sticks}</span>
                </span>
              </span>
            </div>
          )}
          {backendReachable && (
            <div className="readout-row">
              <span className="readout-legend" aria-hidden="true">Video</span>
              <span className="readout-data">
                <span className={`readout-value tone-${video.tone}`}>
                  <span className="status-sq" aria-hidden="true" />
                  <span>
                    <span className="sr-only">Video: </span>
                    {video.value}
                  </span>
                </span>
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
