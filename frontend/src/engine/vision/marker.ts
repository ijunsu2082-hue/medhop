// Ports the data shapes and constants of backend/medhop/vision/marker.py: MarkerObs (with its `size`
// property), Observation, the station-sign geometry and MarkerDetector.MIN_WIDTH. The OpenCV ArUco
// detector itself is not ported (classical computer vision on pixels; the browser engine computes
// the marker's corners from the simulated pose instead).
//
// Both classes take one init object with the Python field names, like the dataclasses' keyword
// arguments, so a field can be added later with a default without touching any caller: give the init
// interface an optional member and the class a readonly field set from `init.<name> ?? <default>`.

import { pyMax } from "../util/num";

export const ARUCO_DICT_NAME = "DICT_4X4_50";

export const A4_WIDTH_M = 0.21;
export const A4_HEIGHT_M = 0.297;
export const SIGN_TOP_MARGIN_M = 0.03;
export const SIGN_CAPTION = "MEDICINE STATION A";

/** MarkerDetector.MIN_WIDTH: a detection narrower than this fraction of the frame width is ignored (16 px at 640). */
export const MIN_WIDTH = 0.025;
/** MarkerDetector's default marker id (Settings.marker_id is 7 as well). */
export const DEFAULT_MARKER_ID = 7;

/** A pixel coordinate (x, y). */
export type Corner = readonly [x: number, y: number];

export interface MarkerObsInit {
  id: number;
  cx: number;
  cy: number;
  width: number;
  /** pixel coordinates: TL, TR, BR, BL */
  corners: readonly Corner[];
  ts?: number;
  height?: number;
  frame_w?: number;
  frame_h?: number;
}

/**
 * One detection.
 *
 * cx and cy are the marker centre as fractions of the frame width and height.
 * width is the mean length of the top and bottom edges divided by the frame width.
 * height is the mean length of the left and right edges, also divided by the frame WIDTH, so the
 * two are directly comparable: for a marker seen square-on they are equal.
 */
export class MarkerObs {
  readonly id: number;
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly corners: readonly Corner[];
  readonly ts: number;
  readonly height: number;
  /** size of the frame the corners are in, pixels */
  readonly frame_w: number;
  readonly frame_h: number;

  constructor(init: MarkerObsInit) {
    this.id = init.id;
    this.cx = init.cx;
    this.cy = init.cy;
    this.width = init.width;
    this.corners = init.corners;
    this.ts = init.ts ?? 0.0;
    this.height = init.height ?? 0.0;
    this.frame_w = init.frame_w ?? 640;
    this.frame_h = init.frame_h ?? 360;
  }

  /**
   * Apparent size that does not shrink when the marker is seen at an angle.
   *
   * A marker viewed from the side gets narrower (width shrinks with the cosine of the angle) but not
   * shorter, so the larger of the two edge measures tracks distance much better.
   */
  get size(): number {
    return pyMax(this.width, this.height);
  }
}

export interface ObservationInit {
  ts: number;
  seq: number;
  marker: MarkerObs | null;
  brightness?: number;
}

/** What the vision step saw in one frame. */
export class Observation {
  /** arrival time of the frame (the link's monotonic clock) */
  readonly ts: number;
  readonly seq: number;
  readonly marker: MarkerObs | null;
  /** mean grey level, 0..255 */
  readonly brightness: number;

  constructor(init: ObservationInit) {
    this.ts = init.ts;
    this.seq = init.seq;
    this.marker = init.marker;
    this.brightness = init.brightness ?? 0.0;
  }
}
