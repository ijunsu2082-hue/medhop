// What the camera frame should say about the picture. Presentation only: this does not change what counts as
// live for the pre-flight checklist or the failsafes (those use link.video_live from the backend).

export type VideoHealth = "unreachable" | "waiting" | "live" | "delayed" | "no_video";

/**
 * The backend reports video_live false once its newest frame is more than 0.5 s old. Up to this age the picture
 * is still shown (as "delayed"); beyond it the frame says there is no video.
 */
export const NO_VIDEO_AFTER_S = 2.0;

export function videoHealth(i: {
  backendReachable: boolean;
  videoLive: boolean | null;
  frameAgeS: number | null | undefined;
}): VideoHealth {
  if (!i.backendReachable) return "unreachable";
  if (i.videoLive === null) return "waiting";
  if (i.videoLive) return "live";
  const age = i.frameAgeS;
  if (typeof age === "number" && Number.isFinite(age) && age <= NO_VIDEO_AFTER_S) return "delayed";
  return "no_video";
}
