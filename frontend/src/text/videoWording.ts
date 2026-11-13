// Text shown on and for the camera frame (VideoFeed). Mode-aware: the simulator is never described as the drone.

export type VideoOverlayKind = "unreachable" | "waiting" | "no_video" | "interrupted" | "connecting";

export interface VideoOverlayText {
  title: string;
  detail: string;
  /** "Last frame N.N s ago", or null when the age is not known or not relevant */
  age: string | null;
}

/**
 * `connecting` is the moment between asking for a stream and its first frame (normally a fraction of a second,
 * on every visit to the Pilot page). It has a calm title, not "No video", because it is the normal start and is
 * announced by screen readers; it is rendered with the `video-overlay--waiting` class and `data-stream="connecting"`
 * so the frame is never a bare black box.
 */
export function videoOverlayText(
  kind: VideoOverlayKind,
  mode: "sim" | "real" | null | undefined,
  frameAgeS: number | null | undefined,
  /** "canvas": the simulator's view drawn in this page (a browser build), where there is no stream to open. */
  feed: "mjpeg" | "canvas" = "mjpeg",
): VideoOverlayText {
  switch (kind) {
    case "unreachable":
      return { title: "No video", detail: feed === "canvas" ? CANVAS_UNREACHABLE_DETAIL : "Backend not reachable.", age: null };
    case "waiting":
      return {
        title: "No video",
        detail: feed === "canvas" ? CANVAS_WAITING_DETAIL : "Waiting for status from the backend.",
        age: null,
      };
    case "connecting":
      return feed === "canvas"
        ? { title: "Connecting", detail: CANVAS_CONNECTING_DETAIL, age: null }
        : { title: "Connecting", detail: "Opening the video stream.", age: null };
    case "interrupted":
      return { title: "Video stream interrupted", detail: "Reconnecting to the stream.", age: null };
    case "no_video":
      return {
        title: "No video",
        detail:
          mode === "sim"
            ? "The simulator is not producing frames. This computer may be busy."
            : "The drone camera is not sending frames.",
        age:
          typeof frameAgeS === "number" && Number.isFinite(frameAgeS)
            ? `Last frame ${frameAgeS.toFixed(1)} s ago`
            : null,
      };
  }
}

/** The "connecting" detail for the drawing made in this page: there is no stream, only a first frame to wait for. */
export const CANVAS_CONNECTING_DETAIL = "Waiting for the first picture from the simulator in this page.";
/** A browser build has no backend process: the status comes from the simulator in this page. */
export const CANVAS_UNREACHABLE_DETAIL = "The simulator in this page is not answering.";
export const CANVAS_WAITING_DETAIL = "Waiting for status from the simulator in this page.";

/** What the drawing made in this page shows, for people who cannot see it. It is never called a camera view. */
export const CANVAS_VIEW_LABEL =
  "Drawing made by the simulator in this page, from the drone's position: the room, the station sign, " +
  "the simulated people and objects, an outline round the tracked sign and a box round each obstacle";

export function videoAlt(mode: "sim" | "real" | null | undefined): string {
  return mode === "sim"
    ? "Annotated simulator camera view: station sign outline and advisory person boxes"
    : "Annotated drone camera view: station sign outline and advisory person boxes";
}
