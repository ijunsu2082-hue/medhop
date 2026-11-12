import { useEffect, useState } from "react";
import { api, blockersFrom, errorText } from "../../api/client";
import type { Status } from "../../api/types";
import { doneMessage } from "../../logic/pilot";
import { abortText, blockerText, missionStateText } from "../../text/wording";
import { IconCross, IconWarn } from "../Icons";
import { DriftAssistControl } from "./DriftAssist";

const RUN_ACTIVE = new Set(["searching", "approaching", "arrived", "landing"]);

interface Props {
  status: Status;
  controlOpen: boolean;
}

export function StationRun({ status, controlOpen }: Props) {
  const m = status.mission;
  const doses = status.care.doses;
  const [doseId, setDoseId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<null | "start" | "abort" | "settings">(null);
  const [refused, setRefused] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [landPending, setLandPending] = useState<boolean | null>(null);

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

  const clientBlockers: string[] = [];
  if (!confirmed) clientBlockers.push("Tick the box to confirm the drone is hovering and the corridor is empty.");
  if (!controlOpen) clientBlockers.push("Your control link is not connected, so you could not take over or stop.");
  const serverBlockers = m.blockers.map(blockerText);
  if (!m.can_start && serverBlockers.length === 0 && !active) serverBlockers.push("The backend reports it cannot start a run right now.");
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

  return (
    <div className="station-run">
      <div className="field">
        <label htmlFor="run-dose">Dose for this run (optional)</label>
        <select
          id="run-dose"
          value={doseId}
          onChange={(e) => {
            setDoseId(e.target.value);
            // Non-text controls give focus back after a change so nothing on the page holds it (SPEC 10.5).
            e.currentTarget.blur();
          }}
          disabled={active}
        >
          <option value="">No dose (practice run)</option>
          {doses.map((d) => (
            <option key={d.id} value={d.id}>
              {d.time} {d.label}
            </option>
          ))}
        </select>
      </div>

      <label className="check-field">
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
      </label>

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

      <div className="row">
        <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={!canStart}>
          {busy === "start" ? "Starting..." : "Start station run"}
        </button>
        <button type="button" className="btn btn-danger-outline" onClick={() => void abort()} disabled={!active || busy === "abort"}>
          Abort run
        </button>
      </div>

      {!active && allBlockers.length > 0 && (
        <div className="blockers" id="run-blockers">
          <p className="blockers-title">Start is not available yet:</p>
          <ul>
            {allBlockers.map((b) => (
              <li key={b}>
                <IconCross size={14} /> {b}
              </li>
            ))}
          </ul>
        </div>
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

      <div className={`run-state run-state-${m.state}`} aria-live="polite" aria-atomic="true">
        <span className="run-state-label">State</span>
        <strong>{missionStateText(m.state)}</strong>
        {(active || m.state === "done" || m.state === "aborted") && (
          <span className="mono">Elapsed {m.elapsed_s.toFixed(1)} s</span>
        )}
        {active && (
          <span className="mono">
            Command yaw {m.command.yaw.toFixed(2)}, pitch {m.command.pitch.toFixed(2)}
          </span>
        )}
        {runDose && m.state !== "idle" && <span>For: {runDose.label}</span>}
        {m.state === "done" && (
          <span>{doneMessage(m.last_landing)}</span>
        )}
      </div>

      {m.state === "aborted" && (
        <div className="abort-notice" role="alert">
          <IconWarn size={28} />
          <div>
            <strong>Take manual control and land</strong>
            <p>The run stopped and will not land the drone for you. {abortText(m.reason)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
