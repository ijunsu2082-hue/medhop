import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, blockersFrom, errorText } from "../../api/client";
import type { Status } from "../../api/types";
import { useHoldGuard } from "../../hooks/useHoldGuard";
import {
  AUTO_STAGES,
  NEEDS_PILOT_TEXT,
  RUN_ACTIVE_STATES,
  alignmentLine,
  autoBlockerTexts,
  autoDistanceLine,
  autoReadyView,
  autoResultView,
  autoStageIndex,
  autoSupported,
  countdownText,
  landingExplainerText,
} from "../../logic/pilot";
import { blockerText, missionStateText } from "../../text/wording";
import { IconChevron, IconCross, IconPass, IconWarn } from "../Icons";
import { HoldButton } from "./HoldButton";

interface Props {
  status: Status;
  controlOpen: boolean;
}

type AudioCtor = typeof AudioContext;

/** A short beep for each countdown second. Silent when the browser has no Web Audio or blocks it. */
function useBeep() {
  const ctxRef = useRef<AudioContext | null>(null);
  return useCallback(() => {
    try {
      if (!ctxRef.current) {
        const C: AudioCtor | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
        if (!C) return;
        ctxRef.current = new C();
      }
      const ctx = ctxRef.current;
      if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.16);
    } catch {
      /* no sound: the countdown is still shown */
    }
  }, []);
}

/** The countdown sentence with its trailing number in its own span, so the number can be set large. Same text. */
function countdownParts(text: string): ReactNode {
  const m = /^(.*?)(\d+)$/.exec(text);
  if (!m) return text;
  return (
    <>
      {m[1]}
      <span className="auto-countdown-num">{m[2]}</span>
    </>
  );
}

/** The Automatic view of the Station run panel: one hold starts a run that takes off, finds the sign and lands. */
export function AutoRun({ status, controlOpen }: Props) {
  const m = status.mission;
  const doses = status.care.doses;
  const [doseId, setDoseId] = useState("");
  const [busy, setBusy] = useState<null | "start" | "abort" | "settings" | "ready">(null);
  const [refused, setRefused] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoPending, setAutoPending] = useState<boolean | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);

  const supported = autoSupported(m);
  const running = RUN_ACTIVE_STATES.has(m.state);
  const blockers = supported ? autoBlockerTexts(m, controlOpen) : [];
  const disabled = !supported || running || blockers.length > 0 || busy !== null;

  // A dose that disappeared from today's list cannot be selected any more.
  useEffect(() => {
    if (doseId && !doses.some((d) => d.id === doseId)) setDoseId("");
  }, [doseId, doses]);

  useEffect(() => {
    if (autoPending !== null && m.auto_fly === autoPending) setAutoPending(null);
  }, [autoPending, m.auto_fly]);

  const start = async () => {
    setBusy("start");
    setError(null);
    setRefused(null);
    try {
      await api.missionStartAuto(doseId || null);
    } catch (e) {
      const b = blockersFrom(e);
      if (b) setRefused(b);
      else setError(`Start failed: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const hold = useHoldGuard(() => void start());
  // Release a hold in progress if the button becomes unavailable mid-hold.
  const holdCancel = hold.cancel;
  useEffect(() => {
    if (disabled) holdCancel();
  }, [disabled, holdCancel]);

  const abort = async () => {
    setBusy("abort");
    setError(null);
    try {
      await api.missionAbort();
    } catch (e) {
      setError(`Stop failed: ${errorText(e)}. Take manual control.`);
    } finally {
      setBusy(null);
    }
  };

  const setAutoFly = async (v: boolean) => {
    setAutoPending(v);
    setBusy("settings");
    setError(null);
    try {
      await api.missionSettings({ auto_fly: v });
    } catch (e) {
      setAutoPending(null);
      setError(`Setting not saved: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const markReady = async () => {
    setBusy("ready");
    setError(null);
    try {
      await api.missionReady();
    } catch (e) {
      setError(`Not marked ready: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  // One beep for each whole second of the countdown.
  const beep = useBeep();
  const countdown = countdownText(m.state, m.countdown_remaining_s);
  useEffect(() => {
    if (countdown !== null) beep();
  }, [countdown, beep]);

  const stage = autoStageIndex(m.state);
  const liveLine =
    m.state === "aligning"
      ? alignmentLine(m.alignment) ?? autoDistanceLine(m.distance_m, m.arrive_distance_m)
      : autoDistanceLine(m.distance_m, m.arrive_distance_m);
  const result = running ? null : autoResultView(m);
  const runDose = m.dose_id ? doses.find((d) => d.id === m.dose_id) : undefined;
  const autoChecked = autoPending ?? m.auto_fly === true;
  const ready = running ? null : autoReadyView({ ...m, auto_fly: autoChecked });
  // Shown until the next run starts; the result card of the run that left it in the air goes inside it.
  const needsPilot = m.needs_pilot === true && !running;

  return (
    <div className="run-steps auto-run">
      {needsPilot && (
        <div className="abort-notice" role="alert">
          <IconWarn size={20} />
          <div>
            <strong>{NEEDS_PILOT_TEXT}</strong>
            {result && result.tone === "warn" && <p>{result.text}</p>}
          </div>
        </div>
      )}

      {!supported ? (
        <p className="msg msg-warn" role="status">
          This backend does not offer automatic runs yet. Use Step by step.
        </p>
      ) : running ? (
        <div className="run-live">
          <ol className="run-track" aria-label="Run progress">
            {AUTO_STAGES.map((label, i) => {
              const cls = i < stage ? "run-track-past" : i === stage ? "run-track-now" : "run-track-next";
              return (
                <li key={label} className={cls} aria-current={i === stage ? "step" : undefined}>
                  <span className="run-track-label">{label}</span>
                </li>
              );
            })}
          </ol>
          <div className="run-state" aria-live="polite" aria-atomic="true">
            {countdown !== null ? (
              <strong className="auto-countdown">{countdownParts(countdown)}</strong>
            ) : (
              <strong>{missionStateText(m.state)}</strong>
            )}
            {liveLine && <span>{liveLine}</span>}
            {runDose && <span>For: {runDose.label}</span>}
          </div>
          <button
            type="button"
            className="btn btn-lg btn-block"
            onClick={(e) => {
              void abort();
              e.currentTarget.blur();
            }}
            disabled={busy === "abort"}
            aria-describedby="auto-stop-desc"
          >
            Stop the run
          </button>
          <p className="hint small auto-help" id="auto-stop-desc">
            {m.state === "countdown"
              ? "Stopping now cancels the takeoff."
              : "The drone stops and hovers. Land it with T or the emergency stop."}
          </p>
        </div>
      ) : (
        <>
          {result &&
            !(needsPilot && result.tone === "warn") &&
            (result.tone === "pass" ? (
              <div className="run-outcome" aria-live="polite" aria-atomic="true">
                <IconPass size={24} />
                <div className="run-outcome-body">
                  <p>{result.text}</p>
                  {runDose && <p className="small">For: {runDose.label}</p>}
                  <Link to="/care" className="btn run-care-link">
                    Open the Care page
                  </Link>
                </div>
              </div>
            ) : (
              <div className="abort-notice" role="alert">
                <IconWarn size={20} />
                <div>
                  <p>{result.text}</p>
                </div>
              </div>
            ))}

          <div className="field">
            <label htmlFor="auto-dose">Which dose is this run for?</label>
            <select
              id="auto-dose"
              value={doseId}
              onChange={(e) => {
                setDoseId(e.target.value);
                // Non-text controls give focus back after a change so nothing on the page holds it (SPEC 10.5).
                e.currentTarget.blur();
              }}
            >
              <option value="">No dose (practice run)</option>
              {doses.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.time} {d.label}
                </option>
              ))}
            </select>
          </div>

          {blockers.length > 0 && (
            <div className="blockers" id="auto-blockers">
              <p className="blockers-title">Before it can fly:</p>
              <ul>
                {blockers.map((b) => (
                  <li key={b}>
                    <IconCross size={20} />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <HoldButton
            hold={hold}
            disabled={disabled}
            label={busy === "start" ? "Starting..." : "Hold to fly to the station"}
            sub="Press and hold for 0.6 s"
            subId="auto-start-desc"
            className="takeoff-large"
          />
          <p className="hint small auto-help">Put the drone on its start spot, facing the sign.</p>
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

      {typeof m.auto_fly === "boolean" && (
        <div className="auto-schedule">
          <label className="switch-field">
            <input
              type="checkbox"
              role="switch"
              aria-checked={autoChecked}
              checked={autoChecked}
              onChange={(e) => {
                void setAutoFly(e.target.checked);
                e.currentTarget.blur();
              }}
              disabled={busy === "settings"}
              aria-describedby="auto-fly-desc"
            />
            <span className="switch-track" aria-hidden="true" />
            <span className="switch-word" aria-hidden="true">
              {autoChecked ? "On" : "Off"}
            </span>
            <span>Fly automatically when a dose is due</span>
          </label>
          <p className="hint small" id="auto-fly-desc">
            Keep this page open while it is on. The emergency stop has to stay one press away.
          </p>
          {ready &&
            (ready.ready ? (
              <p className="small auto-ready" role="status">
                {ready.text}
              </p>
            ) : (
              <div className="auto-ready">
                <p className="small">{ready.text}</p>
                <button
                  type="button"
                  className="btn"
                  onClick={(e) => {
                    void markReady();
                    e.currentTarget.blur();
                  }}
                  disabled={busy === "ready" || running}
                >
                  Ready for the next dose
                </button>
              </div>
            ))}
        </div>
      )}

      <button
        type="button"
        className="disclosure"
        aria-expanded={explainOpen}
        aria-controls="auto-explain"
        onClick={(e) => {
          setExplainOpen((o) => !o);
          // Give focus back so Space and the flight keys never land on this button (SPEC 10.5).
          e.currentTarget.blur();
        }}
      >
        <IconChevron className="disclosure-chevron" />
        Where does it land?
      </button>
      <div className="run-options" id="auto-explain" hidden={!explainOpen}>
        <p className="small">{landingExplainerText(m.arrive_distance_m)}</p>
      </div>
    </div>
  );
}
