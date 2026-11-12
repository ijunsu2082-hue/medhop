import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../../api/client";
import type { Trim } from "../../api/types";
import { formatSigned } from "../../logic/time";

const STEP = 0.01;
const LIMIT = 0.3;

function clampRound(v: number): number {
  return Math.round(Math.max(-LIMIT, Math.min(LIMIT, v)) * 100) / 100;
}

/** Roll / pitch trim nudges. PUT /api/trim with the full {roll, pitch}. */
export function TrimPanel({ trim }: { trim: Trim }) {
  // While taps are in flight, build on the last value we asked for, not the (slightly older) status.
  const [pending, setPending] = useState<Trim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  const shown = pending ?? trim;

  const put = (next: Trim) => {
    setPending(next);
    setError(null);
    if (settle.current) clearTimeout(settle.current);
    api
      .putTrim(next)
      .then(() => {
        settle.current = setTimeout(() => setPending(null), 800);
      })
      .catch((e) => {
        setPending(null);
        setError(`Trim not saved: ${errorText(e)}`);
      });
  };

  const nudge = (droll: number, dpitch: number) =>
    put({ roll: clampRound(shown.roll + droll), pitch: clampRound(shown.pitch + dpitch) });

  return (
    <div className="trim">
      <div className="trim-values mono" aria-live="polite">
        <span className="trim-stat">
          <span className="trim-k">Roll</span> <span className="trim-v">{formatSigned(shown.roll)}</span>
        </span>
        <span className="trim-stat">
          <span className="trim-k">Pitch</span> <span className="trim-v">{formatSigned(shown.pitch)}</span>
        </span>
      </div>
      <div className="trim-grid">
        <button type="button" className="btn" onClick={() => nudge(-STEP, 0)} disabled={shown.roll <= -LIMIT}>
          Trim left
        </button>
        <button type="button" className="btn" onClick={() => nudge(STEP, 0)} disabled={shown.roll >= LIMIT}>
          Trim right
        </button>
        <button type="button" className="btn" onClick={() => nudge(0, STEP)} disabled={shown.pitch >= LIMIT}>
          Trim forward
        </button>
        <button type="button" className="btn" onClick={() => nudge(0, -STEP)} disabled={shown.pitch <= -LIMIT}>
          Trim back
        </button>
        <button
          type="button"
          className="btn btn-quiet btn-sm trim-reset"
          onClick={() => put({ roll: 0, pitch: 0 })}
          disabled={shown.roll === 0 && shown.pitch === 0}
        >
          Reset trim
        </button>
      </div>
      <p className="hint">Drifting right? Tap Trim left. Drifting forward? Tap Trim back. Steps of 0.01, limit 0.30.</p>
      {error && (
        <p className="msg msg-fail" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
