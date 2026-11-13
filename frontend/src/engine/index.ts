// The in-page backend's public face (engine.ts). Pages reach it through the browser transport
// (transport/browser.ts); the landing page's live demo may use it directly:
//
//   const engine = getEngine();
//   engine.start();                                             // the loop (idempotent; stop() pauses)
//   const pilot = engine.connectPilot();                        // the pilot slot, or null when taken
//   engine.request("POST", "/api/sim/scenario", { name: "crossing" });
//   engine.request("POST", "/api/mission/start", { automatic: true, dose_id: null });
//   engine.setSpeed(2);                                         // refused while flying by hand
//   const off = engine.subscribeFrames((frame) => draw(frame)); // SceneFrames for scene/SceneCanvas
//   engine.status();                                            // the status document (GET /api/status)
//   pilot?.close(); off(); engine.resetDemoData();

export {
  Engine,
  getEngine,
  sceneFrameOf,
  HOUSEKEEPING_MS,
  MAX_FRAME_ELAPSED_S,
  MAX_SPEED,
  MIN_SPEED,
  PILOT_BUSY_CLOSE_CODE,
  VIRTUAL_START_S,
  type EngineOptions,
  type FrameListener,
  type FrameScheduler,
  type PilotSession,
} from "./engine";
export { BAD_REQUEST, HELLO, PILOT_BUSY_REASON, type ControlAck, type ControlError, type ControlReply } from "./server/control";
export type { RouteResponse } from "./server/router";
export type { EngineStatus, StatusSim, StatusSimPose } from "./server/status";
export { DEMO_KEY, EVENTS_KEEP, dosesAhead } from "./server/demoData";
