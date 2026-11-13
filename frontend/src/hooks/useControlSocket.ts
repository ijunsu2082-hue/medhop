// WS /ws/control as a React hook. The connection logic (backoff, 4001 refusal, hello) lives in
// control/controlConnection.ts; the socket itself comes from this build's transport (transport/index.ts).
//
// Every message the page sends passes the mode guard first (logic/modeGuard.ts, guardedControlSend): once the
// backend's mode has changed under this page, only the emergency stop is sent. The link itself stays connected,
// so the emergency stop always has a way out.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ControlMessage } from "../api/types";
import { ControlConnection, type ControlState, type ServerMessageAt } from "../control/controlConnection";
import { guardedControlSend, pageModeChange } from "../logic/modeGuard";
import { getTransport } from "../transport";

export type { ControlState } from "../control/controlConnection";

export interface ControlSocket {
  state: ControlState;
  /** Returns false when the message was NOT sent (link not open, or refused by the mode guard). */
  send: (msg: ControlMessage) => boolean;
  lastServerMessage: ServerMessageAt | null;
  /** Why the mode guard last refused a message, or null while it has refused none. */
  refused: string | null;
}

export function useControlSocket(): ControlSocket {
  const [state, setState] = useState<ControlState>("connecting");
  const [lastServerMessage, setLast] = useState<ServerMessageAt | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const connRef = useRef<ControlConnection | null>(null);

  useEffect(() => {
    const transport = getTransport();
    const conn = new ControlConnection(
      {
        create: () => transport.createControl(),
        OPEN: transport.controlOpenState,
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
        clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
        now: () => Date.now(),
      },
      { state: setState, message: setLast },
    );
    connRef.current = conn;
    // Deferred by a tick so React StrictMode's mount/unmount/mount in development opens one socket, not two.
    conn.start(0);
    return () => {
      conn.stop();
      if (connRef.current === conn) connRef.current = null;
    };
  }, []);

  const rawSend = useCallback((msg: ControlMessage) => connRef.current?.send(msg) ?? false, []);
  // The one choke point: the guard's latch is read on every message, not captured at render.
  const send = useMemo(() => guardedControlSend(rawSend, pageModeChange, setRefused), [rawSend]);

  return { state, send, lastServerMessage, refused };
}
