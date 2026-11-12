// WS /ws/control as a React hook. The connection logic (backoff, 4001 refusal, hello) lives in
// control/controlConnection.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import { wsUrl } from "../api/config";
import type { ControlMessage } from "../api/types";
import { ControlConnection, type ControlState, type ServerMessageAt, type WsLike } from "../control/controlConnection";

export type { ControlState } from "../control/controlConnection";

export interface ControlSocket {
  state: ControlState;
  /** Returns false when the message was NOT sent. */
  send: (msg: ControlMessage) => boolean;
  lastServerMessage: ServerMessageAt | null;
}

export function useControlSocket(): ControlSocket {
  const [state, setState] = useState<ControlState>("connecting");
  const [lastServerMessage, setLast] = useState<ServerMessageAt | null>(null);
  const connRef = useRef<ControlConnection | null>(null);

  useEffect(() => {
    const conn = new ControlConnection(
      {
        create: () => new WebSocket(wsUrl("/ws/control")) as unknown as WsLike,
        OPEN: WebSocket.OPEN,
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

  const send = useCallback((msg: ControlMessage) => connRef.current?.send(msg) ?? false, []);

  return { state, send, lastServerMessage };
}
