import { useState } from "react";
import { ApiError, api, blockersFrom, errorText } from "../../api/client";
import type { Status } from "../../api/types";
import { blockerText } from "../../text/wording";
import { VerdictTag } from "../Verdict";

const HOVER_TEST_S = 10;
const RUN_ACTIVE = new Set(["countdown", "taking_off", "searching", "approaching", "aligning", "arrived", "landing", "hover_test"]);

export function HoverTestPanel({ status }: { status: Status }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ht = status.hover_test;
  const running = ht?.running ?? false;
  const markerVisible = status.vision.marker !== null;
  const runActive = RUN_ACTIVE.has(status.mission.state);
  const blocked = !markerVisible ? "The station sign must be in view." : runActive ? "A run is in progress." : null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.hoverTestStart();
    } catch (e) {
      const blockers = blockersFrom(e);
      if (blockers && blockers.length > 0) {
        setError(`Refused: ${blockers.map(blockerText).join(" ")}`);
      } else if (e instanceof ApiError && e.status === 409) {
        const detail = (e.body as { detail?: unknown } | null)?.detail;
        setError(`Refused: ${typeof detail === "string" ? detail : "no station sign in view, or a run is active."}`);
      } else {
        setError(`Hover test failed to start: ${errorText(e)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const r = ht?.result ?? null;
  const elapsed = Math.min(HOVER_TEST_S, ht?.elapsed_s ?? 0);

  return (
    <div className="hover-test">
      <p className="hint">
        Hover facing the station sign. For 10 s the backend holds the sticks neutral (trim still applies) and measures drift.
      </p>
      <div className="setup-action">
        <button type="button" className="btn btn-block setup-wide" onClick={() => void start()} disabled={busy || running || blocked !== null}>
          {running ? "Hover test running" : "Start hover test"}
        </button>
        {blocked && !running && <span className="hint small">{blocked}</span>}
      </div>
      {running && (
        <div className="progress-row">
          <label htmlFor="hover-progress">Progress</label>
          <progress id="hover-progress" max={HOVER_TEST_S} value={elapsed} />
          <span className="mono">
            {elapsed.toFixed(1)} / {HOVER_TEST_S} s
          </span>
        </div>
      )}
      {error && (
        <p className="msg msg-fail" role="alert">
          {error}
        </p>
      )}
      {r && !running && (
        <div className="hover-result" aria-live="polite">
          <VerdictTag verdict={r.pass ? "pass" : "fail"} />
          <dl className="kv">
            <dt>Drift</dt>
            <dd className="mono">{r.drift_frame_widths.toFixed(2)} frame widths</dd>
            <dt>Drift (estimate)</dt>
            <dd className="mono">{r.drift_m_estimate.toFixed(2)} m estimate</dd>
            <dt>Sign size change</dt>
            <dd className="mono">{r.width_change_pct.toFixed(1)} %</dd>
            <dt>Sign visible</dt>
            <dd className="mono">{r.visible_pct.toFixed(0)} % of the time</dd>
          </dl>
          <p className="hint">Pass means drift within 0.5 m (estimate) and the sign visible at least 80 % of the time.</p>
        </div>
      )}
    </div>
  );
}

export function ArrivalCalibration({ status }: { status: Status }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const marker = status.vision.marker;

  const calibrate = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.calibrateArrival();
      setMsg({ ok: true, text: marker ? `Saved. Sign width at press: ${marker.width.toFixed(2)}.` : "Saved." });
    } catch (e) {
      setMsg({
        ok: false,
        text: blockersFrom(e)?.length
          ? `Not saved: ${blockersFrom(e)!.map(blockerText).join(" ")}`
          : e instanceof ApiError && e.status === 409
            ? "Not saved: no station sign is visible."
            : `Not saved: ${errorText(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="calibration">
      <p className="hint">Hold the drone by hand at the stopping distance, facing the sign, then press.</p>
      <div className="setup-action">
        <button type="button" className="btn btn-block setup-wide" onClick={() => void calibrate()} disabled={busy || marker === null}>
          Set arrival distance from current view
        </button>
        {marker === null && <span className="hint small">The station sign must be in view.</span>}
      </div>
      <p className="mono small setup-readout">
        Arrive width now: {status.mission.arrive_width.toFixed(2)} of frame
        {marker ? `; sign width now: ${marker.width.toFixed(2)}` : ""}
      </p>
      {msg && (
        <p className={`msg ${msg.ok ? "msg-pass" : "msg-fail"}`} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
