import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, blockersFrom, errorText } from "../../api/client";
import type { MissionState, Status } from "../../api/types";
import { doneMessage } from "../../logic/pilot";
import { abortText, blockerText, missionStateText } from "../../text/wording";
import { IconCheck, IconCross, IconWarn } from "../Icons";
import { DriftAssistControl } from "./DriftAssist";
import { HoldButton, type Hold } from "./HoldButton";
import { IconChevron } from "./PilotIcons";

const RUN_ACTIVE = new Set(["searching", "approaching", "arrived", "landing"]);

// The live track while a run is active. "Done" is shown as the outcome card once the run ends.
const TRACK: { state: MissionState; label: string }[] = [
  { state: "searching", label: "Searching" },
  { state: "approaching", label: "Approaching" },
  { state: "arrived", label: "Arrived" },
  { state: "landing", label: "Landing" },
  { state: "done", label: "Done" },
];

// Server blockers that belong to a step get its number in front.
const BLOCKER_STEP: Record<string, number> = { confirm_airborne_required: 2 };

interface Props {
  status: Status;
  controlOpen: boolean;
  /** the same takeoff/land hold object as the button in the safety bar */
  hold: Hold;
  takeoffBlocked: string | null;
  takeoffNote: { ok: boolean | null; text: string } | null;
  /** a takeoff/land toggle was acknowledged by the backend in this page session (presentation only) */
  takeoffAcked: boolean;
}

interface Blocker {
  step: number | null;
  text: string;
}

export function RunSteps({ status, controlOpen, hold, takeoffBlocked, takeoffNote, takeoffAcked }: Props) {
  const m = status.mission;
  const doses = status.care.doses;
  const sim = status.mode === "sim";
  const [doseId, setDoseId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<null | "start" | "abort" | "settings">(null);
  const [refused, setRefused] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [landPending, setLandPending] = useState<boolean | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);

  const active = RUN_ACTIVE.has(m.state);

  // A dose that disappeared from today's list cannot be selected any more.
  useEffect(() => {
    if (doseId && !doses.some((d) => d.id === doseId)) setDoseId("");
  }, [doseId, doses]);

  // The confirmation is for one run: clear it when a run starts.
  useEffect(() => {
    if (active) setConfirmed(false);
  }, [active]);

  useEffect(() => {
    if (landPending !== null && m.land_on_arrival === landPending) setLandPending(null);
  }, [landPending, m.land_on_arrival]);

  const clientBlockers: Blocker[] = [];
  if (!confirmed) clientBlockers.push({ step: 2, text: "Tick the box to confirm the drone is hovering and the corridor is empty." });
  if (!controlOpen) clientBlockers.push({ step: null, text: "Your control link is not connected, so you could not take over or stop." });
  const serverBlockers: Blocker[] = m.blockers.map((code) => ({ step: BLOCKER_STEP[code] ?? null, text: blockerText(code) }));
  if (!m.can_start && serverBlockers.length === 0 && !active)
    serverBlockers.push({ step: null, text: "The backend reports it cannot start a run right now." });
  const allBlockers = [...serverBlockers, ...clientBlockers];
  const canStart = m.can_start && allBlockers.length === 0 && busy === null && !active;

  const start = async () => {
    setBusy("start");
    setError(null);
    setRefused(null);
    try {
      await api.missionStart(doseId || null);
      setConfirmed(false);
    } catch (e) {
      const b = blockersFrom(e);
      if (b) setRefused(b);
      else setError(`Start failed: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const abort = async () => {
    setBusy("abort");
    setError(null);
    try {
      await api.missionAbort();
    } catch (e) {
      setError(`Abort failed: ${errorText(e)}. Take manual control.`);
    } finally {
      setBusy(null);
    }
  };

  const setLand = async (v: boolean) => {
    setLandPending(v);
    setBusy("settings");
    setError(null);
    try {
      await api.missionSettings({ land_on_arrival: v });
    } catch (e) {
      setLandPending(null);
      setError(`Setting not saved: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const runDose = m.dose_id ? doses.find((d) => d.id === m.dose_id) : undefined;
  const landChecked = landPending ?? m.land_on_arrival;

  // Which step to highlight. Presentation only: nothing here is gated on it.
  const current = active || confirmed ? 3 : takeoffAcked ? 2 : 1;
  const liveLine = takeoffBlocked ?? takeoffNote?.text ?? "";
  const trackIndex = TRACK.findIndex((t) => t.state === m.state);

  const step = (n: number, title: string, body: ReactNode) => (
    <li className={`run-step${current === n ? " run-step-current" : ""}`} aria-current={current === n ? "step" : undefined}>
      <span className="run-step-num" aria-hidden="true">
        {n}
      </span>
      <div className="run-step-body">
        <h3 className="run-step-title">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        {body}
      </div>
    </li>
  );

  return (
    <div className="run-steps">
      <h2 id="h-run">{sim ? "Station run (simulator)" : "Station run"}</h2>
      <ol className="run-step-list">
        {step(
          1,
          "Take off",
          <>
            <HoldButton
              hold={hold}
              disabled={takeoffBlocked !== null}
              label="Takeoff / Land (toggle)"
              sub="Press and hold 0.6 s. Key: hold T"
              subId="takeoff-step-desc"
              keyShortcut="T"
              className="takeoff-large"
            />
            <p className="run-step-text">Hold T, or press and hold this button for 0.6 s.</p>
            <p className="run-step-live" role="status">
              {liveLine}
            </p>
            <p className="hint small">The drone does not report that it is in the air. You confirm that in step 2.</p>
          </>,
        )}

        {step(
          2,
          "Confirm",
          <label className={`confirm-card${confirmed ? " confirm-card-on" : ""}`}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => {
                setConfirmed(e.target.checked);
                e.currentTarget.blur();
              }}
              disabled={active}
            />
            <span>The drone is hovering and the corridor is empty</span>
          </label>,
        )}

        {step(
          3,
          "Start station run",
          <>
            {active ? (
              <div className="run-live">
                <ol className="run-track" aria-label="Run progress">
                  {TRACK.map((t, i) => {
                    const cls = i < trackIndex ? "run-track-past" : i === trackIndex ? "run-track-now" : "run-track-next";
                    return (
                      <li key={t.state} className={cls} aria-current={i === trackIndex ? "step" : undefined}>
                        <span className="run-track-label">{t.label}</span>
                      </li>
                    );
                  })}
                </ol>
                <div className="run-state" aria-live="polite" aria-atomic="true">
                  <strong>{missionStateText(m.state)}</strong>
                  <span className="mono">Elapsed {m.elapsed_s.toFixed(1)} s</span>
                  <span className="mono">
                    Command yaw {m.command.yaw.toFixed(2)}, pitch {m.command.pitch.toFixed(2)}
                  </span>
                  {runDose && <span>For: {runDose.label}</span>}
                </div>
                <button type="button" className="btn btn-danger run-wide" onClick={() => void abort()} disabled={busy === "abort"}>
                  Abort run
                </button>
              </div>
            ) : (
              <>
                {m.state === "done" && (
                  <div className="run-outcome" aria-live="polite" aria-atomic="true">
                    <IconCheck size={28} />
                    <div>
                      <strong>{missionStateText("done")}</strong>
                      <p>{doneMessage(m.last_landing)}</p>
                      <p className="mono small">Elapsed {m.elapsed_s.toFixed(1)} s</p>
                      {runDose && <p className="small">For: {runDose.label}</p>}
                      <Link to="/care" className="run-care-link">
                        Open the Care page
                      </Link>
                    </div>
                  </div>
                )}

                {m.state === "aborted" && (
                  <>
                    <div className="run-state run-state-aborted" aria-live="polite" aria-atomic="true">
                      <strong>{missionStateText(m.state)}</strong>
                      <span className="mono">Elapsed {m.elapsed_s.toFixed(1)} s</span>
                      {runDose && <span>For: {runDose.label}</span>}
                    </div>
                    <div className="abort-notice" role="alert">
                      <IconWarn size={28} />
                      <div>
                        <strong>Take manual control and land</strong>
                        <p>The run stopped and will not land the drone for you. {abortText(m.reason)}</p>
                      </div>
                    </div>
                  </>
                )}

                {m.state === "hover_test" && (
                  <div className="run-state" aria-live="polite" aria-atomic="true">
                    <strong>{missionStateText(m.state)}</strong>
                  </div>
                )}

                <div className="field">
                  <label htmlFor="run-dose">Which dose is this run for?</label>
                  <select
                    id="run-dose"
                    value={doseId}
                    onChange={(e) => {
                      setDoseId(e.target.value);
                      // Non-text controls give focus back after a change so nothing on the page holds it (SPEC 10.5).
                      e.currentTarget.blur();
                    }}
                    disabled={active}
                    aria-describedby="run-dose-hint"
                  >
                    <option value="">No dose (practice run)</option>
                    {doses.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.time} {d.label}
                      </option>
                    ))}
                  </select>
                  <span className="hint small" id="run-dose-hint">
                    Pick a dose so the Care page shows that it arrived at the station. No dose is a practice run.
                  </span>
                </div>

                {allBlockers.length > 0 && (
                  <div className="blockers" id="run-blockers">
                    <p className="blockers-title">Before you can start:</p>
                    <ul>
                      {allBlockers.map((b) => (
                        <li key={b.text}>
                          <IconCross size={14} />
                          <span>
                            {b.step !== null && <strong className="blocker-step">Step {b.step}:</strong>} {b.text}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <button
                  type="button"
                  className="btn btn-primary run-wide"
                  onClick={() => void start()}
                  disabled={!canStart}
                  aria-describedby={allBlockers.length > 0 ? "run-blockers" : undefined}
                >
                  {busy === "start" ? "Starting..." : "Start station run"}
                </button>
              </>
            )}

            {refused && (
              <div className="msg msg-fail" role="alert">
                <p>The backend refused the start:</p>
                <ul>
                  {refused.map((b) => (
                    <li key={b}>{blockerText(b)}</li>
                  ))}
                </ul>
              </div>
            )}
            {error && (
              <p className="msg msg-fail" role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              className="disclosure"
              aria-expanded={optionsOpen}
              aria-controls="run-options"
              onClick={(e) => {
                setOptionsOpen((o) => !o);
                // Give focus back so Space and the flight keys never land on this button (SPEC 10.5).
                e.currentTarget.blur();
              }}
            >
              <IconChevron className="disclosure-chevron" />
              Run options
            </button>
            <div className="run-options" id="run-options" hidden={!optionsOpen}>
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={landChecked}
                  onChange={(e) => {
                    void setLand(e.target.checked);
                    e.currentTarget.blur();
                  }}
                  disabled={busy === "settings"}
                />
                <span>Send the landing command on arrival (off: you land by hand)</span>
              </label>
              {m.drift_assist && <DriftAssistControl da={m.drift_assist} trim={status.trim} runActive={active} />}
            </div>
          </>,
        )}
      </ol>
    </div>
  );
}
