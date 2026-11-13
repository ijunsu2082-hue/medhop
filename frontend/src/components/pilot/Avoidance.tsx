import { useEffect, useState } from "react";
import { api, blockersFrom, errorText } from "../../api/client";
import type { MissionAvoid, SimScenarioName, Status } from "../../api/types";
import { AVOID_SWITCH_LABEL, SCENARIOS, avoidHint, avoidLine, scenarioRefusalText, scenarioText } from "../../text/avoidWording";

/** The avoidance line inside a run's live state: a word with a mark. Waiting and blocked are not faults: never red. */
export function AvoidLine({ avoid }: { avoid: MissionAvoid | null | undefined }) {
  const view = avoidLine(avoid);
  if (!view) return null;
  return (
    <span className={`state avoid-line tone-${view.tone}`}>
      <span className="dot" aria-hidden="true" />
      <span>{view.text}</span>
    </span>
  );
}

interface SwitchProps {
  status: Status;
  runActive: boolean;
  /** which view it sits in: the hint differs, because only an automatic run lands by itself */
  view: "auto" | "steps";
}

/** "Wait for people and obstacles", bound to the `avoid` setting. Hidden when the backend does not send it. */
export function AvoidSwitch({ status, runActive, view }: SwitchProps) {
  const avoid = status.mission.avoid;
  const on = avoid?.mode === "hold";
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (pending !== null && on === pending) setPending(null);
  }, [pending, on]);

  if (!avoid) return null;
  const checked = pending ?? on;
  const descId = `avoid-desc-${view}`;

  const save = async (v: boolean) => {
    setPending(v);
    setBusy(true);
    setError(null);
    try {
      await api.setAvoid(v ? "hold" : "off");
    } catch (e) {
      setPending(null);
      setError(`Setting not saved: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="avoid-setting">
      <label className="switch-field">
        <input
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          onChange={(e) => {
            void save(e.target.checked);
            // Give focus back so Space and the flight keys never land on this switch (SPEC 10.5).
            e.currentTarget.blur();
          }}
          disabled={busy || runActive}
          aria-describedby={descId}
        />
        <span className="switch-track" aria-hidden="true" />
        <span className="switch-word" aria-hidden="true">
          {checked ? "On" : "Off"}
        </span>
        <span>{AVOID_SWITCH_LABEL}</span>
      </label>
      <p className="hint" id={descId}>
        {avoidHint(status.mode, status.vision.person.enabled, view)}
      </p>
      {error && (
        <p className="msg msg-fail" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Simulator only: who or what is in the corridor. Not rendered at all on the real drone (`status.sim` null). */
export function CorridorSelect({ status, runActive, id }: { status: Status; runActive: boolean; id: string }) {
  const sim = status.sim;
  const current = sim?.scenario ?? null;
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  // The backend's scenario is the truth: once it changes, show it.
  useEffect(() => {
    setPending(null);
  }, [current]);

  if (!sim) return null;
  const value = pending ?? sim.scenario;
  const names: string[] = (SCENARIOS as readonly string[]).includes(value) ? [...SCENARIOS] : [...SCENARIOS, value];

  const choose = async (name: string) => {
    setPending(name);
    setBusy(true);
    setRefusal(null);
    try {
      await api.setSimScenario(name as SimScenarioName);
    } catch (e) {
      setPending(null);
      const blockers = blockersFrom(e);
      setRefusal(blockers ? scenarioRefusalText(blockers) : `Not changed: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <label htmlFor={id}>Corridor</label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          void choose(e.target.value);
          // Non-text controls give focus back after a change so nothing on the page holds it (SPEC 10.5).
          e.currentTarget.blur();
        }}
        disabled={runActive || busy}
      >
        {names.map((n) => (
          <option key={n} value={n}>
            {scenarioText(n)}
          </option>
        ))}
      </select>
      {refusal && (
        <p className="msg msg-warn" role="alert">
          {refusal}
        </p>
      )}
    </div>
  );
}
