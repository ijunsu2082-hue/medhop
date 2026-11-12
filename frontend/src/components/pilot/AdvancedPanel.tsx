import { useState, type ReactNode } from "react";
import type { ControlMessage, Status } from "../../api/types";
import { IconChevron } from "../Icons";
import { CalibrateLevel } from "./CalibrateLevel";
import { ArrivalCalibration, HoverTestPanel } from "./HoverAndCalibration";
import type { Hold } from "./HoldButton";
import { MaxStickSlider } from "./ManualControls";
import { TrimPanel } from "./TrimPanel";
import "./setup.css";

interface Props {
  /** null while there is no status (or the backend is not reachable) */
  status: Status | null;
  /** shown in place of a sub-card that needs status */
  waiting: ReactNode;
  send: (m: ControlMessage) => boolean;
  controlOpen: boolean;
  calHold: Hold;
  calBlocked: string | null;
  calNote: { ok: boolean | null; text: string } | null;
}

/**
 * "Setup and tuning": closed by default, open while a hover test runs. The content stays mounted when closed
 * (only hidden), so a sub-card keeps its messages and nothing is torn down mid-action.
 */
export function AdvancedPanel({ status, waiting, send, controlOpen, calHold, calBlocked, calNote }: Props) {
  const [userOpen, setUserOpen] = useState(false);
  const hoverRunning = status?.hover_test?.running ?? false;
  const open = userOpen || hoverRunning;

  const row = (id: string, title: string, description: string, body: ReactNode) => (
    <section className="setup-row" aria-labelledby={id}>
      <div className="setup-row-head">
        <h3 id={id}>{title}</h3>
        <p className="setup-desc">{description}</p>
      </div>
      <div className="setup-row-body">{body}</div>
    </section>
  );

  return (
    <section className="section pilot-setup" aria-labelledby="h-setup">
      <div className="section-head pilot-setup-head">
        <span className="section-index" aria-hidden="true">
          04
        </span>
        <h2 id="h-setup" className="pilot-setup-heading">
          <button
            type="button"
            className="disclosure disclosure-heading"
            aria-expanded={open}
            aria-controls="setup-body"
            onClick={(e) => {
              setUserOpen(!open);
              // Give focus back so Space and the flight keys never land on this button (SPEC 10.5).
              e.currentTarget.blur();
            }}
          >
            <IconChevron className="disclosure-chevron" size={20} />
            Setup and tuning
            {!open && (
              <span className="setup-summary" aria-hidden="true">
                Trim, stick limit, hover test, calibration
              </span>
            )}
          </button>
        </h2>
      </div>
      {hoverRunning && <p className="hint small">Open while the hover test runs.</p>}
      <div className="setup-grid" id="setup-body" hidden={!open}>
        {row("h-trim", "Trim", "Small constant stick offsets that cancel drift.", status ? <TrimPanel trim={status.trim} /> : waiting)}
        {row(
          "h-maxstick",
          "Max stick",
          "Upper limit on how far the keys and pads push the sticks.",
          <MaxStickSlider serverValue={status?.pilot.max_stick ?? null} send={send} disabled={!controlOpen} />,
        )}
        {row("h-hover", "Hover test", "Hovers in place and estimates sideways drift.", status ? <HoverTestPanel status={status} /> : waiting)}
        {row(
          "h-cal",
          "Arrival calibration",
          "Records how large the sign looks at the landing spot.",
          status ? <ArrivalCalibration status={status} /> : waiting,
        )}
        {row(
          "h-level",
          "Calibrate level",
          "Only on flat ground with the motors off.",
          <CalibrateLevel hold={calHold} blocked={calBlocked} note={calNote} />,
        )}
      </div>
    </section>
  );
}
