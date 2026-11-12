import { useState } from "react";
import type { Status } from "../../api/types";
import { RUN_ACTIVE_STATES, RUN_MODE_KEY, parseRunMode, type RunMode } from "../../logic/pilot";
import { AutoRun } from "./AutoRun";
import type { Hold } from "./HoldButton";
import { RunSteps } from "./RunSteps";

interface Props {
  status: Status;
  controlOpen: boolean;
  hold: Hold;
  takeoffBlocked: string | null;
  takeoffNote: { ok: boolean | null; text: string } | null;
  takeoffAcked: boolean;
  onResetEstop: () => void;
}

function loadMode(): RunMode {
  try {
    return parseRunMode(window.localStorage.getItem(RUN_MODE_KEY));
  } catch {
    return "auto";
  }
}

function saveMode(mode: RunMode) {
  try {
    window.localStorage.setItem(RUN_MODE_KEY, mode);
  } catch {
    /* storage unavailable: the choice lasts for this page only */
  }
}

const MODES: { mode: RunMode; label: string }[] = [
  { mode: "auto", label: "Automatic" },
  { mode: "steps", label: "Step by step" },
];

/** The Station run panel: title, the Automatic / Step by step choice, and the chosen view. */
export function StationRun(props: Props) {
  const { status, controlOpen } = props;
  const [chosen, setMode] = useState<RunMode>(loadMode);
  const sim = status.mode === "sim";
  // An automatic run in progress (for example one a dose started) always shows the automatic view.
  const autoRunning = status.mission.automatic === true && RUN_ACTIVE_STATES.has(status.mission.state);
  const mode: RunMode = autoRunning ? "auto" : chosen;

  return (
    <>
      <h2 id="h-run">
        Station run
        {sim && (
          <>
            {" "}
            <span className="chip run-title-chip">
              <span className="sr-only">(</span>simulator<span className="sr-only">)</span>
            </span>
          </>
        )}
      </h2>
      <div className="run-mode" role="group" aria-label="How to run">
        {MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            className="run-mode-option"
            aria-pressed={mode === m.mode}
            onClick={(e) => {
              setMode(m.mode);
              saveMode(m.mode);
              // Give focus back so Space and the flight keys never land on this button (SPEC 10.5).
              e.currentTarget.blur();
            }}
          >
            {m.label}
          </button>
        ))}
      </div>
      {mode === "auto" ? <AutoRun status={status} controlOpen={controlOpen} /> : <RunSteps {...props} />}
    </>
  );
}
