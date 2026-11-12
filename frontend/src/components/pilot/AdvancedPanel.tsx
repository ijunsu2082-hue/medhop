import { useState, type ReactNode } from "react";
import type { ControlMessage, Status } from "../../api/types";
import { CalibrateLevel } from "./CalibrateLevel";
import { ArrivalCalibration, HoverTestPanel } from "./HoverAndCalibration";
import type { Hold } from "./HoldButton";
import { MaxStickSlider } from "./ManualControls";
import { IconChevron } from "./PilotIcons";
import { TrimPanel } from "./TrimPanel";

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

  return (
    <section className="panel pilot-setup" aria-labelledby="h-setup">
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
          <IconChevron className="disclosure-chevron" size={16} />
          Setup and tuning
          {!open && (
            <span className="setup-summary" aria-hidden="true">
              Trim, stick limit, hover test, calibration
            </span>
          )}
        </button>
      </h2>
      {hoverRunning && <p className="hint small">Open while the hover test runs.</p>}
      <div className="setup-grid" id="setup-body" hidden={!open}>
        <section className="setup-card" aria-labelledby="h-trim">
          <h3 id="h-trim">Trim</h3>
          {status ? <TrimPanel trim={status.trim} /> : waiting}
        </section>
        <section className="setup-card" aria-labelledby="h-maxstick">
          <h3 id="h-maxstick">Max stick</h3>
          <MaxStickSlider serverValue={status?.pilot.max_stick ?? null} send={send} disabled={!controlOpen} />
        </section>
        <section className="setup-card" aria-labelledby="h-hover">
          <h3 id="h-hover">Hover test</h3>
          {status ? <HoverTestPanel status={status} /> : waiting}
        </section>
        <section className="setup-card" aria-labelledby="h-cal">
          <h3 id="h-cal">Arrival calibration</h3>
          {status ? <ArrivalCalibration status={status} /> : waiting}
        </section>
        <section className="setup-card" aria-labelledby="h-level">
          <h3 id="h-level">Calibrate level</h3>
          <CalibrateLevel hold={calHold} blocked={calBlocked} note={calNote} />
        </section>
      </div>
    </section>
  );
}
