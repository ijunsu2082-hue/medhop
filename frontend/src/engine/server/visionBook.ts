// The bookkeeping of backend/medhop/vision/worker.py that the status reads (VisionWorker.snapshot): when the
// newest frame arrived, the arrival log behind `link.fps`, the newest marker (shown for MARKER_VISIBLE_S after
// its last detection), the newest brightness and the dark flag. The vision step itself (decode, ArUco,
// annotation, rate log) is not here: the engine steps the synthetic detector (vision/detector.ts) and calls
// `record()` with what Python's process_once writes under its lock, at the same point.
//
// Differences from Python: no lock and no thread; `brightness` is the detector module's estimatedBrightness
// (the browser has no picture to average).

import type { MarkerObs } from "../vision/marker";

/** mean grey level below this is reported as dark */
export const DARK_BRIGHTNESS = 40.0;
/** status shows the marker for this long after its last detection */
export const MARKER_VISIBLE_S = 1.0;
/** same threshold as the mixer's video failsafe */
export const VIDEO_LIVE_S = 0.5;
/** link.fps is averaged over this long */
export const FPS_WINDOW_S = 2.0;
/** Python deque(maxlen=128) */
const ARRIVALS_MAX = 128;

/** VisionSnapshot, with the Python field names. */
export interface VisionSnapshot {
  readonly frame_age_s: number | null;
  readonly video_live: boolean;
  readonly fps: number;
  readonly marker: MarkerObs | null;
  readonly marker_age_s: number | null;
  readonly brightness: number | null;
  readonly dark: boolean;
}

export class VisionBook {
  private _frameTs: number | null = null;
  /** (time first seen here, frame seq) */
  private _arrivals: [now: number, seq: number][] = [];
  private _marker: MarkerObs | null = null;
  private _brightness: number | null = null;

  /** What process_once writes for a processed frame (Python, under its lock). */
  record(now: number, frameTs: number, seq: number, marker: MarkerObs | null, brightness: number): void {
    this._frameTs = frameTs;
    this._arrivals.push([now, seq]);
    if (this._arrivals.length > ARRIVALS_MAX) this._arrivals.shift();
    this._brightness = brightness;
    if (marker !== null) this._marker = marker;
  }

  /** VisionWorker.snapshot(now). */
  snapshot(now: number): VisionSnapshot {
    const frameAge = this._frameTs === null ? null : Math.max(0.0, now - this._frameTs);
    // Camera frame arrival: frames that came in (by sequence number) during the last FPS_WINDOW_S, divided by
    // that time. Less than a full window of history: never divide by less than a second.
    let fps = 0.0;
    const arrivals = this._arrivals;
    if (arrivals.length > 0) {
      const start = now - FPS_WINDOW_S;
      const before = arrivals.filter((item) => item[0] < start);
      const latest = arrivals[arrivals.length - 1]!;
      if (latest[0] >= start) {
        if (before.length > 0) {
          fps = (latest[1] - before[before.length - 1]![1]) / FPS_WINDOW_S;
        } else {
          fps = (latest[1] - arrivals[0]![1]) / Math.max(1.0, now - arrivals[0]![0]);
        }
      }
      fps = Math.max(0.0, fps);
    }
    let marker = this._marker;
    let markerAge = marker === null ? null : Math.max(0.0, now - marker.ts);
    if (markerAge === null || markerAge > MARKER_VISIBLE_S) {
      marker = null;
      markerAge = null;
    }
    const brightness = this._brightness;
    const live = frameAge !== null && frameAge <= VIDEO_LIVE_S;
    return {
      frame_age_s: frameAge,
      video_live: live,
      fps: live ? fps : 0.0,
      marker,
      marker_age_s: markerAge,
      brightness,
      dark: brightness !== null && brightness < DARK_BRIGHTNESS,
    };
  }
}
