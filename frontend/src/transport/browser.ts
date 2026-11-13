// Browser transport placeholder: the in-page simulator (src/engine/) is wired in here by the next step.
// Until then this transport reaches nothing, and says so: every request is refused as unreachable, the status
// stream never opens, a control socket closes as soon as it is opened, and the camera is a canvas source that
// never draws a frame. So a browser build shows its usual "not connected" and "no video" states, never a picture.

import type { WsLike } from "../control/controlConnection";
import type { Transport } from "./types";

/** In the message of every refused request, so a placeholder build is easy to recognise in the console. */
export const PLACEHOLDER_MARKER = "browser transport placeholder: the in-page simulator is not wired in yet";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/** A control socket that closes at once: its close event fires on the next tick, after the caller has attached
 * its handlers, with the code of an abnormal close (so the caller retries with its usual backoff). */
function closedControlSocket(): WsLike {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ws: WsLike = {
    readyState: CONNECTING,
    send: () => {
      /* never open: nothing is sent */
    },
    close: () => {
      ws.readyState = CLOSED;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  timer = setTimeout(() => {
    timer = null;
    ws.readyState = CLOSED;
    ws.onclose?.({ code: 1006 });
  }, 0);
  return ws;
}

export function createTransport(): Transport {
  return {
    kind: "browser",
    request: (method, path) => Promise.reject(new Error(`${method} ${path}: ${PLACEHOLDER_MARKER}`)),
    openStatus: () => ({
      close: () => {
        /* never opened */
      },
    }),
    createControl: closedControlSocket,
    controlOpenState: OPEN,
    camera: {
      kind: "canvas",
      subscribe: () => () => {
        /* never emits */
      },
    },
  };
}
