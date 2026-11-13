// The browser transport: the simulator runs inside this page (src/engine, the port of the Python backend), and
// this file is the only one of the app that reaches it (transport.guard.test.ts). It plays the parts the network
// plays for transport/python.ts:
//
// - request(): one call of the engine's router (server.py's routes, with their status codes and bodies),
//   answered on a later microtask, with a copied body.
// - openStatus(): opens on the next tick, then delivers a fresh status document about five times a second
//   (STATUS_PUSH_MS, as WS /ws/status does), each a deep copy made of plain objects, until closed.
// - createControl(): a WsLike in place of WS /ws/control. It opens on the next tick (the caller assigns its
//   handlers after this returns); with the pilot slot free it then receives {"type":"hello","pilot":true} as a
//   JSON string, and answers every JSON string sent to it with a JSON string, as the server does; with the slot
//   taken it closes with code 4001, as the server does. Closing it releases the slot (a run in progress is
//   aborted with pilot_link_lost).
// - camera: the canvas source; every frame the flight logic was stepped with, as a SceneFrame.
//
// The engine is started (its animation-frame loop) on first use, and is the page's one shared engine, so state
// carries across the pages of the app.

import type { WsLike } from "../control/controlConnection";
import { getEngine, PILOT_BUSY_CLOSE_CODE, type Engine, type PilotSession } from "../engine";
import type { StatusStreamHandlers, Transport, TransportResponse } from "./types";

/** WS /ws/status pushes this often (server.py STATUS_PUSH_S). */
export const STATUS_PUSH_MS = 200;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;
/** The close code a socket closed by this page gets (a normal closure). */
const NORMAL_CLOSE = 1000;

/** A deep copy made only of plain objects, arrays and JSON values (what the network would deliver). */
function copied<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** A control socket on the engine's pilot slot. */
export function engineControlSocket(engine: Engine): WsLike {
  let session: PilotSession | null = null;
  let closeNotified = false;

  const deliver = (data: string) => {
    setTimeout(() => {
      if (ws.readyState === OPEN) ws.onmessage?.({ data });
    }, 0);
  };
  const notifyClose = (code: number) => {
    if (closeNotified) return;
    closeNotified = true;
    ws.onclose?.({ code });
  };

  const ws: WsLike = {
    readyState: CONNECTING,
    send: (data: string) => {
      if (ws.readyState !== OPEN || session === null) return;
      const reply = session.receiveText(String(data));
      if (reply !== null) deliver(JSON.stringify(reply));
    },
    close: () => {
      if (ws.readyState === CLOSED) return;
      ws.readyState = CLOSED;
      const held = session;
      session = null;
      held?.close(); // synchronous, like the server's finally: release_pilot()
      setTimeout(() => notifyClose(NORMAL_CLOSE), 0);
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  setTimeout(() => {
    if (ws.readyState !== CONNECTING) return; // closed before it opened
    engine.start();
    // Accepted first, so a refusal carries its close code (server.py ws_control).
    ws.readyState = OPEN;
    const claimed = engine.connectPilot();
    ws.onopen?.({});
    if (claimed === null) {
      ws.readyState = CLOSED;
      notifyClose(PILOT_BUSY_CLOSE_CODE);
      return;
    }
    if (ws.readyState !== OPEN) {
      claimed.close(); // the caller closed it in onopen
      return;
    }
    session = claimed;
    deliver(JSON.stringify(claimed.hello));
  }, 0);

  return ws;
}

/** The browser transport on `engine` (the page's shared engine by default). */
export function createTransport(engine: Engine = getEngine()): Transport {
  async function request(method: string, path: string, body: unknown): Promise<TransportResponse> {
    engine.start();
    const answer = engine.request(method, path, copied(body));
    return { status: answer.status, body: answer.body === undefined ? null : copied(answer.body) };
  }

  function openStatus(h: StatusStreamHandlers) {
    engine.start();
    let open = true;
    let interval: ReturnType<typeof setInterval> | null = null;
    const push = () => {
      if (open) h.message(copied(engine.status()));
    };
    const opener = setTimeout(() => {
      if (!open) return;
      h.open();
      push();
      interval = setInterval(push, STATUS_PUSH_MS);
    }, 0);
    return {
      close: () => {
        open = false;
        clearTimeout(opener);
        if (interval !== null) clearInterval(interval);
        interval = null;
      },
    };
  }

  return {
    kind: "browser",
    request,
    openStatus,
    createControl: () => engineControlSocket(engine),
    controlOpenState: OPEN,
    camera: {
      kind: "canvas",
      subscribe: (listener) => {
        engine.start();
        return engine.subscribeFrames(listener);
      },
    },
  };
}
