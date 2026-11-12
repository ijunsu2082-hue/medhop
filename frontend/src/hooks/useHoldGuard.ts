import { useCallback, useEffect, useRef, useState } from "react";
import { HoldGuard, TAKEOFF_HOLD_MS } from "../control/holdGuard";

/** React wrapper around HoldGuard with a progress value (0..1) for rendering. */
export function useHoldGuard(onFire: () => void, holdMs = TAKEOFF_HOLD_MS) {
  const fireRef = useRef(onFire);
  fireRef.current = onFire;
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const rafRef = useRef<number | null>(null);

  const guardRef = useRef<HoldGuard | null>(null);
  if (guardRef.current === null) {
    guardRef.current = new HoldGuard(() => {
      stopRaf();
      setProgress(0);
      setHolding(false);
      fireRef.current();
    }, holdMs);
  }

  function stopRaf() {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }

  const start = useCallback(() => {
    const g = guardRef.current!;
    if (g.holding) return;
    g.start();
    setHolding(true);
    const loop = () => {
      if (!g.holding) return;
      setProgress(g.progress());
      rafRef.current = requestAnimationFrame(loop);
    };
    stopRaf();
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const cancel = useCallback(() => {
    guardRef.current!.cancel();
    stopRaf();
    setProgress(0);
    setHolding(false);
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  return { start, cancel, progress, holding };
}
