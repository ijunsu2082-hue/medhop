// What the app does with a backend, in one interface. There are two: transport/python.ts (the MedHop backend over
// HTTP, two WebSockets and an MJPEG stream) and transport/browser.ts (the simulator inside this page). Which one a
// build uses is fixed when it is built (transport/index.ts) and never changes while a page is open.

import type { WsLike } from "../control/controlConnection";
import type { SceneFrame } from "../scene/drawScene";
import type { BackendKind } from "./kind";

/** One answered request, whatever its status. `body` is the parsed JSON, the raw text when it is not JSON, or
 * null when the response had no body. */
export interface TransportResponse {
  status: number;
  body: unknown;
}

/** Handlers for the status stream. `message` is given one status snapshot: a JSON string to parse, or the object
 * itself. */
export interface StatusStreamHandlers {
  open: () => void;
  message: (data: unknown) => void;
  close: () => void;
}

/** Something opened by the transport. close() detaches the handlers first, so none runs after it. */
export interface Closable {
  close: () => void;
}

/** The camera picture. "mjpeg": an MJPEG stream an <img> loads from `url`. "canvas": frames drawn in this page. */
export type CameraSource =
  | { kind: "mjpeg"; url: string }
  | {
      kind: "canvas";
      /** Calls `listener` with every new frame; returns the function that stops it. */
      subscribe(listener: (frame: SceneFrame) => void): () => void;
    };

export interface Transport {
  readonly kind: BackendKind;
  /**
   * One request to the REST API (`path` starts with /api/). Resolves with any answer, an error status included;
   * rejects only when the backend cannot be reached or does not answer within `timeoutMs`.
   */
  request(method: string, path: string, body: unknown, timeoutMs: number): Promise<TransportResponse>;
  /** Open the status stream (WS /ws/status). May throw; the caller then retries. */
  openStatus(handlers: StatusStreamHandlers): Closable;
  /** Open a control socket (WS /ws/control). May throw; the caller then retries. */
  createControl(): WsLike;
  /** The readyState of an open control socket (WebSocket.OPEN for a real one). */
  readonly controlOpenState: number;
  readonly camera: CameraSource;
}
