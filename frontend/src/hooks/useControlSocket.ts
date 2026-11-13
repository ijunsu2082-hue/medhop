// WS /ws/control as a React hook. The connection logic (backoff, 4001 refusal, hello) lives in
// control/controlConnection.ts; the socket itself comes from this build's transport (transport/index.ts).

import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlMessage } from "../api/types";
import { ControlConnection, type ControlState, type ServerMessageAt } from "../control/controlConnection";
import { getTransport } from "../transport";

export type { ControlState } from "../control/controlConnection";

export interface ControlSocket {
  state: ControlState;
  /** Returns false when the message was NOT sent. */
  send: (msg: ControlMessage) => boolean;
  lastServerMessage: ServerMessageAt | null;
}

/**
 * `enabled` false keeps the link closed: an open link is closed (the usual stop, which sends zero sticks first)
 * and nothing is sent. The Pilot page passes false once the mode guard has tripped (logic/modeGuard.ts).
 */
export function useControlSocket(enabled = true): ControlSocket {
  const [state, setState] = useState<ControlState>("connecting");
  const [lastServerMessage, setLast] = useState<ServerMessageAt | null>(null);
  const connRef = useRef<ControlConnection | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState("closed");
      return;
    }
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
  }, [enabled]);

  const send = useCallback((msg: ControlMessage) => connRef.current?.send(msg) ?? false, []);

  return { state, send, lastServerMessage };
}
