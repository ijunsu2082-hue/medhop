import { useEffect, useRef, useState } from "react";
import type { ControlMessage } from "../api/types";
import { FlightInput, ZERO_AXES, flightKeyDown, flightKeyUp, isTextEntry, type Axes, type FlightKeyHandlers } from "../control/flightInput";

interface Options {
  send: (m: ControlMessage) => boolean;
  onEstop: () => void;
  onTakeoffHoldStart: () => void;
  onTakeoffHoldCancel: () => void;
}

/**
 * Window-level keyboard flying for the Pilot page (logic in control/flightInput.ts, flightKeyDown/flightKeyUp).
 * - Flight keys, T and Space pause only while real text entry has focus (text inputs, textarea, contenteditable)
 *   and while the tab is hidden. Sliders, checkboxes, radios, buttons and selects never block them.
 * - Window blur, tab hidden, a Cmd/Meta press (macOS drops key-up events while Cmd is held) and unmount
 *   release every key and send one zero `axes` message. (On-screen pads also release on window-level
 *   pointerup / pointercancel: see StickPad.)
 */
export function useFlightKeyboard(opts: Options): { flight: FlightInput; axes: Axes; keysPaused: boolean } {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const flightRef = useRef<FlightInput | null>(null);
  if (flightRef.current === null) {
    flightRef.current = new FlightInput((m) => {
      optsRef.current.send(m);
    });
  }
  const flight = flightRef.current;

  const [axes, setAxes] = useState<Axes>(ZERO_AXES);
  const [keysPaused, setKeysPaused] = useState(false);

  useEffect(() => flight.subscribe(setAxes), [flight]);

  useEffect(() => {
    const releaseAll = () => {
      flight.releaseAll();
      optsRef.current.onTakeoffHoldCancel();
    };
    const handlers: FlightKeyHandlers = {
      flight,
      releaseAll,
      onEstop: () => optsRef.current.onEstop(),
      onTakeoffHoldStart: () => optsRef.current.onTakeoffHoldStart(),
      onTakeoffHoldCancel: () => optsRef.current.onTakeoffHoldCancel(),
    };

    const focused = () => document.activeElement as HTMLElement | null;
    const onKeyDown = (e: KeyboardEvent) => flightKeyDown(e, focused(), document.hidden, handlers);
    const onKeyUp = (e: KeyboardEvent) => flightKeyUp(e, focused(), handlers);

    const onVisibility = () => {
      if (document.hidden) releaseAll();
    };

    const onFocusChange = () => {
      // focusout fires before the new element is focused; read activeElement on the next tick.
      setTimeout(() => setKeysPaused(isTextEntry(document.activeElement as HTMLElement | null)), 0);
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("focusin", onFocusChange);
    document.addEventListener("focusout", onFocusChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("focusin", onFocusChange);
      document.removeEventListener("focusout", onFocusChange);
      flight.releaseAll();
    };
  }, [flight]);

  return { flight, axes, keysPaused };
}
