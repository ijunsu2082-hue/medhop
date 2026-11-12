import { useEffect, useState } from "react";
import { api, errorText } from "../../api/client";
import type { DriftAssist, Trim } from "../../api/types";
import { formatSigned } from "../../logic/time";
import { suggestedTrimBody } from "../../logic/trim";
import { driftDisabledText } from "../../text/wording";

interface Props {
  da: DriftAssist;
  trim: Trim;
  runActive: boolean;
}

/** "Drift assist (experimental)" inside the Station run panel. Hidden by the caller when status has no drift_assist. */
export function DriftAssistControl({ da, trim, runActive }: Props) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<null | "toggle" | "apply">(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  useEffect(() => {
    if (pending !== null && da.enabled === pending) setPending(null);
  }, [pending, da.enabled]);

  // A new suggestion (or a new run) replaces the "applied" note.
  useEffect(() => {
    setApplied(null);
  }, [da.suggested_trim_roll]);

  const checked = pending ?? da.enabled;

  const toggle = async (v: boolean) => {
    setPending(v);
    setBusy("toggle");
    setError(null);
    try {
      await api.missionSettings({ drift_assist: v });
    } catch (e) {
      setPending(null);
      setError(`Setting not saved: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const body = suggestedTrimBody(da.suggested_trim_roll, trim);
  const showSuggestion = !runActive && body !== null;

  const apply = async () => {
    if (!body) return;
    setBusy("apply");
    setError(null);
    setApplied(null);
    try {
      await api.putTrim(body);
      setApplied(`Trim set to roll ${formatSigned(body.roll)}, pitch ${formatSigned(body.pitch)}.`);
    } catch (e) {
      setError(`Trim not saved: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="drift-assist">
      <label className="switch-field">
        <input
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          onChange={(e) => {
            void toggle(e.target.checked);
            e.currentTarget.blur();
          }}
          disabled={busy === "toggle"}
          aria-describedby="drift-desc"
        />
        <span className="switch-track" aria-hidden="true" />
        <span className="switch-word" aria-hidden="true">
          {checked ? "On" : "Off"}
        </span>
        <span>Drift assist (experimental)</span>
      </label>
      <p className="hint small" id="drift-desc">
        Uses the camera view of the sign to counter sideways drift. Experimental: keep a hand on the controls.
      </p>

      {da.active && (
        <p className="mono small" aria-live="polite">
          Drift assist roll now: {formatSigned(da.roll)}
        </p>
      )}

      {da.disabled_reason && (
        <p className="msg msg-warn" role="status">
          {driftDisabledText(da.disabled_reason)}
        </p>
      )}

      {showSuggestion && body && (
        <div className="row">
          <span className="mono">Suggested roll trim: {formatSigned(da.suggested_trim_roll ?? body.roll)}</span>
          <button
            type="button"
            className="btn"
            onClick={() => void apply()}
            disabled={busy === "apply" || trim.roll === body.roll}
          >
            Apply as trim
          </button>
          {trim.roll === body.roll && <span className="muted small">Already the current roll trim.</span>}
        </div>
      )}

      {applied && (
        <p className="msg msg-pass" role="status">
          {applied}
        </p>
      )}
      {error && (
        <p className="msg msg-fail" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
