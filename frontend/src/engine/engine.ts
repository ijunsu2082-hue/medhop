// The in-page backend: what backend/medhop/server.py is for the Python build, inside the browser. It owns one
// EngineCore (server/core.ts, the port of MedHopCore) and drives it:
//
// - Virtual time. One clock, starting at 1000 s like the tests' FakeClock, advanced 1/60 s per step
//   (server/core.ts step(): exactly SimHarness.step). In the browser requestAnimationFrame drives it with an
//   accumulator, accumulated += min(real elapsed, 0.1 s) * speed, so a hidden tab (no animation frames) simply
//   pauses virtual time and nothing times out. advance(seconds) steps without any browser API, for tests.
// - Speed: 1 by default. Faster is allowed only while no manual stick input is active, and it falls back to 1
//   the moment the pilot sends any (manual flying depends on real-time key repeats).
// - Wall-clock housekeeping once a second, and when the tab becomes visible again: the care monitor's tick and
//   the automatic-flight-for-a-due-dose rule (core.housekeeping()).
// - The pilot slot: one control connection at a time (connectPilot()); a second is refused (the transport
//   closes it with code 4001); closing the connection releases the slot and aborts a run with
//   pilot_link_lost, as server.py does.
// - The camera: every frame the runner was stepped with becomes a SceneFrame (scene/drawScene.ts) for the
//   canvas: the frame's pose snapshot, the marker corners of that detection, the runner's obstacle snapshot
//   and the landing spot.
//
// getEngine() is the one shared instance of a page: state carries across pages of the app. It is created
// lazily and does not run until start() (the browser transport starts it on first use).

import type { KeyValueStorage } from "./care/storage";
import { browserStorage, GuardedStorage } from "./care/storage";
import { PILOT_BUSY_CLOSE_CODE, HELLO, type ControlReply } from "./server/control";
import { EngineCore, PHYSICS_DT, type SteppedFrame } from "./server/core";
import { DEMO_DATA_KEYS } from "./server/demoData";
import { route, type RouteResponse } from "./server/router";
import type { EngineStatus } from "./server/status";
import { SILENT_LOGGER, type Logger } from "./util/log";
import type { SceneFrame, SceneObstacle } from "../scene/drawScene";

/** Where virtual time starts (the tests' FakeClock does too). */
export const VIRTUAL_START_S = 1000.0;
/** At most this much real time is turned into virtual time per animation frame. */
export const MAX_FRAME_ELAPSED_S = 0.1;
export const HOUSEKEEPING_MS = 1000;
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;

/** Animation-frame scheduling (window.requestAnimationFrame by default; tests pass their own or none). */
export interface FrameScheduler {
  request(callback: (timeMs: number) => void): unknown;
  cancel(handle: unknown): void;
}

export interface EngineOptions {
  /** The storage the care data persists in. Default: the browser's localStorage (memory when unavailable). Pass null for memory. */
  storage?: KeyValueStorage | null;
  /** Unix seconds. Default Date.now() / 1000. */
  wallClock?: () => number;
  /** Seeds the simulator's and the detector's noise. Default: a random seed. */
  seed?: number;
  /** Default: requestAnimationFrame when the page has one, else a 16 ms timer. null: never runs by itself (advance() only). */
  scheduler?: FrameScheduler | null;
  /** Run the wall-clock housekeeping on a 1 s timer while started (default true). */
  housekeepingTimer?: boolean;
  logger?: Logger;
}

/** A held pilot slot: the in-page stand-in for an accepted /ws/control socket. */
export interface PilotSession {
  /** What the server sends first: {"type": "hello", "pilot": true}. */
  readonly hello: typeof HELLO;
  /** One message as the socket's text frame (JSON). Returns the reply to send, or null. */
  receiveText(text: string): ControlReply | null;
  /** One message already parsed. Returns the reply to send, or null. */
  receive(message: unknown): ControlReply | null;
  /** Release the slot (idempotent): zero the pilot axes and abort a run with pilot_link_lost. */
  close(): void;
  readonly closed: boolean;
}

export type FrameListener = (frame: SceneFrame) => void;

function defaultScheduler(): FrameScheduler {
  const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number; cancelAnimationFrame?: (h: number) => void };
  if (typeof g.requestAnimationFrame === "function" && typeof g.cancelAnimationFrame === "function") {
    const raf = g.requestAnimationFrame.bind(globalThis);
    const caf = g.cancelAnimationFrame.bind(globalThis);
    return { request: (cb) => raf(cb), cancel: (h) => caf(h as number) };
  }
  return {
    request: (cb) => setTimeout(() => cb(realNowMs()), 16),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

function realNowMs(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p ? p.now() : Date.now();
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

export class Engine {
  private readonly _options: EngineOptions;
  private readonly _storage: KeyValueStorage | null;
  private readonly _wallClock: () => number;
  private readonly _scheduler: FrameScheduler | null;
  private readonly _logger: Logger;
  private _core: EngineCore;
  private _t = VIRTUAL_START_S;
  private _speed = 1;
  private _accumulated = 0;
  private _running = false;
  private _frameHandle: unknown = null;
  private _lastFrameMs: number | null = null;
  private _housekeepingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _frameListeners = new Set<FrameListener>();
  private _session: PilotSessionImpl | null = null;
  private _stepCount = 0;
  private _onVisibility: (() => void) | null = null;

  constructor(options: EngineOptions = {}) {
    this._options = options;
    this._storage = options.storage === undefined ? browserStorage() : options.storage;
    this._wallClock = options.wallClock ?? (() => Date.now() / 1000);
    this._scheduler = options.scheduler === undefined ? defaultScheduler() : options.scheduler;
    this._logger = options.logger ?? SILENT_LOGGER;
    this._core = this._buildCore();
  }

  private _buildCore(): EngineCore {
    return new EngineCore({
      clock: () => this._t,
      wallClock: this._wallClock,
      storage: this._storage,
      seed: this._options.seed ?? randomSeed(),
      logger: this._logger,
      onFrame: (frame) => this._emitFrame(frame),
      onPilotAxes: (values) => {
        if (values.some((v) => Math.abs(v) > 1e-6)) this._speed = 1;
      },
    });
  }

  /** The core (simulator, runner, store, ...). For tests and tools; pages use request(), status() and connectPilot(). */
  get core(): EngineCore {
    return this._core;
  }

  // ------------------------------------------------------------------------------------------ //
  // time

  /** The virtual clock, seconds (starts at VIRTUAL_START_S). */
  get now(): number {
    return this._t;
  }

  /** Physics steps taken so far. */
  get steps(): number {
    return this._stepCount;
  }

  get running(): boolean {
    return this._running;
  }

  get speed(): number {
    return this._speed;
  }

  /**
   * Run virtual time faster (or slower) than real time. Refused (false, speed unchanged) while manual stick
   * input is active, and for a value outside MIN_SPEED..MAX_SPEED. Any manual stick input sets it back to 1.
   */
  setSpeed(speed: number): boolean {
    if (!Number.isFinite(speed) || speed < MIN_SPEED || speed > MAX_SPEED) return false;
    if (speed !== 1 && this._core.mixer.snapshot(this._t).manual_active) return false;
    this._speed = speed;
    return true;
  }

  /** One physics step (1/60 s of virtual time). */
  step(): void {
    this._t += PHYSICS_DT;
    this._stepCount += 1;
    this._core.step(this._t);
  }

  /** Advance virtual time by `seconds` (whole steps), without any browser API. Returns the steps taken. */
  advance(seconds: number): number {
    const end = this._t + seconds;
    let n = 0;
    while (this._t < end - 1e-9) {
      this.step();
      n += 1;
    }
    return n;
  }

  /** Step until `until()` is true or `seconds` of virtual time have passed. Returns whether it became true. */
  advanceUntil(until: () => boolean, seconds: number): boolean {
    const end = this._t + seconds;
    while (this._t < end - 1e-9) {
      this.step();
      if (until()) return true;
    }
    return until();
  }

  /** Start the loop (idempotent). Also starts the 1 s housekeeping timer and the tab-visibility hook. */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._lastFrameMs = null;
    this._accumulated = 0;
    if (this._scheduler !== null) this._frameHandle = this._scheduler.request((ms) => this._onAnimationFrame(ms));
    if (this._options.housekeepingTimer !== false) {
      this._housekeepingTimer = setInterval(() => this.housekeeping(), HOUSEKEEPING_MS);
      const doc = (globalThis as { document?: { visibilityState?: string; addEventListener?: Function; removeEventListener?: Function } }).document;
      if (doc && typeof doc.addEventListener === "function") {
        this._onVisibility = () => {
          if (doc.visibilityState === "visible") {
            this._lastFrameMs = null; // a long hidden spell is not replayed
            this.housekeeping();
          }
        };
        doc.addEventListener("visibilitychange", this._onVisibility);
      }
    }
    this.housekeeping();
  }

  /** Pause the loop and the housekeeping (idempotent). State is kept: start() carries on from here. */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this._frameHandle !== null && this._scheduler !== null) this._scheduler.cancel(this._frameHandle);
    this._frameHandle = null;
    if (this._housekeepingTimer !== null) clearInterval(this._housekeepingTimer);
    this._housekeepingTimer = null;
    const doc = (globalThis as { document?: { removeEventListener?: Function } }).document;
    if (this._onVisibility && doc && typeof doc.removeEventListener === "function") {
      doc.removeEventListener("visibilitychange", this._onVisibility);
    }
    this._onVisibility = null;
  }

  private _onAnimationFrame(ms: number): void {
    this._frameHandle = null;
    if (!this._running) return;
    if (this._lastFrameMs !== null) {
      const elapsed = Math.max(0, (ms - this._lastFrameMs) / 1000);
      this._accumulated += Math.min(elapsed, MAX_FRAME_ELAPSED_S) * this._speed;
      while (this._accumulated >= PHYSICS_DT - 1e-12) {
        this._accumulated -= PHYSICS_DT;
        this.step();
      }
    }
    this._lastFrameMs = ms;
    if (this._running && this._scheduler !== null) this._frameHandle = this._scheduler.request((t) => this._onAnimationFrame(t));
  }

  /** The wall-clock housekeeping, once (core.housekeeping()): new-day reseed, care monitor, automatic flights. */
  housekeeping(): void {
    this._core.housekeeping();
  }

  // ------------------------------------------------------------------------------------------ //
  // the API

  /** GET /api/status. */
  status(): EngineStatus {
    return this._core.status();
  }

  /** One REST request (server.py's routes): `path` starts with /api/ and may carry a query string. */
  request(method: string, path: string, body?: unknown): RouteResponse {
    return route(this._core, method, path, body);
  }

  /**
   * Claim the pilot slot (an accepted /ws/control socket). null when another pilot holds it: the transport
   * then closes its socket with PILOT_BUSY_CLOSE_CODE (4001).
   */
  connectPilot(): PilotSession | null {
    if (this._session !== null && this._session.closed) this._session = null;
    if (!this._core.claimPilot()) return null;
    const session = new PilotSessionImpl(this, this._core);
    this._session = session;
    return session;
  }

  get pilotConnected(): boolean {
    return this._core.pilotConnected();
  }

  /** Every SceneFrame from now on; returns the function that stops it. */
  subscribeFrames(listener: FrameListener): () => void {
    this._frameListeners.add(listener);
    return () => {
      this._frameListeners.delete(listener);
    };
  }

  private _emitFrame(frame: SteppedFrame): void {
    if (this._frameListeners.size === 0) return;
    const scene = sceneFrameOf(frame, this._core.landingDistanceM());
    for (const listener of [...this._frameListeners]) {
      try {
        listener(scene);
      } catch {
        this._logger.log("error", "a camera frame listener failed");
      }
    }
  }

  /**
   * Start again with fresh demo data: the stored schedule, event log and mission settings are removed, the
   * simulator, the runner and everything else is built new (the scenario is back to empty, virtual time carries
   * on). A run is aborted first. A connected pilot keeps the slot on the new core.
   */
  resetDemoData(): void {
    const pilot = this._core.pilotConnected();
    this._core.shutdown();
    const guarded = new GuardedStorage(this._storage, this._logger);
    for (const key of DEMO_DATA_KEYS) guarded.removeItem(key);
    this._core = this._buildCore();
    if (pilot) this._core.claimPilot();
    if (this._session !== null && !this._session.closed) this._session.rebind(this._core);
    this._speed = 1;
  }

  /** Called by a session when it closes. */
  _sessionClosed(session: PilotSessionImpl): void {
    if (this._session === session) this._session = null;
  }
}

class PilotSessionImpl implements PilotSession {
  readonly hello = HELLO;
  private _closed = false;

  constructor(
    private readonly _engine: Engine,
    private _core: EngineCore,
  ) {}

  get closed(): boolean {
    return this._closed;
  }

  rebind(core: EngineCore): void {
    this._core = core;
  }

  receiveText(text: string): ControlReply | null {
    if (this._closed) return null;
    return this._core.handleControlText(text);
  }

  receive(message: unknown): ControlReply | null {
    if (this._closed) return null;
    return this._core.handleControl(message);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._core.releasePilot();
    this._engine._sessionClosed(this);
  }
}

/** The SceneFrame for one stepped frame. */
export function sceneFrameOf(frame: SteppedFrame, landingSpot: number | null): SceneFrame {
  const obstacles: SceneObstacle[] = frame.obstacles.map((o) => ({
    kind: o.kind === "object" ? "object" : "person",
    box: [o.box[0] ?? 0, o.box[1] ?? 0, o.box[2] ?? 0, o.box[3] ?? 0],
    distance_m: o.distance_m,
    in_lane: o.in_lane,
  }));
  return {
    view: frame.view,
    marker: frame.marker === null ? null : frame.marker.corners,
    obstacles,
    landingSpot,
  };
}

export { PILOT_BUSY_CLOSE_CODE };

let shared: Engine | null = null;

/** The page's one engine (created on first call, not started). */
export function getEngine(): Engine {
  shared ??= new Engine();
  return shared;
}
