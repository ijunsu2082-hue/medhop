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
): VideoOverlayText {
  switch (kind) {
    case "unreachable":
      return { title: "No video", detail: "Backend not reachable.", age: null };
    case "waiting":
      return { title: "No video", detail: "Waiting for status from the backend.", age: null };
    case "connecting":
      return { title: "Connecting", detail: "Opening the video stream.", age: null };
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

export function videoAlt(mode: "sim" | "real" | null | undefined): string {
  return mode === "sim"
    ? "Annotated simulator camera view: station sign outline and advisory person boxes"
    : "Annotated drone camera view: station sign outline and advisory person boxes";
}
