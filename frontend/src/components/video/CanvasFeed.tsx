import { useEffect, useRef, useState } from "react";
import { useOptionalStatus } from "../../hooks/useStatus";
import type { StreamState } from "../../logic/streamController";
import { videoHealth } from "../../logic/videoHealth";
import { SceneCanvas } from "../../scene/SceneCanvas";
import type { SceneFrame } from "../../scene/drawScene";
import { CANVAS_VIEW_LABEL, videoOverlayText, type VideoOverlayKind } from "../../text/videoWording";
import type { CameraSource } from "../../transport";
import type { VideoFeedProps } from "./feedProps";
import "./video.css";

export type CanvasCameraSource = Extract<CameraSource, { kind: "canvas" }>;

interface Props extends VideoFeedProps {
  /** The transport's canvas camera. Subscribed to once per mount: it is fixed for the page's life. */
  source: CanvasCameraSource;
}

/**
 * The simulator's view, drawn in this page, in the same 16:9 frame and with the same overlays as the MJPEG feed.
 * The stream state is "connecting" until the first frame and "playing" from then on: there is no connection here
 * that could break, so it is never "interrupted". Whether there is video at all is the status's call (videoHealth),
 * as for the MJPEG feed. onFrameSize is never called: a drawing has no camera resolution to report.
 */
export function CanvasFeed(props: Props) {
  const { videoLive, backendReachable, tags, onStreamState } = props;
  const shared = useOptionalStatus()?.status ?? null;
  const mode = props.mode !== undefined ? props.mode : (shared?.mode ?? null);
  const frameAgeS = props.frameAgeS !== undefined ? props.frameAgeS : (shared?.link.frame_age_s ?? null);
  const [frame, setFrame] = useState<SceneFrame | null>(null);
  const stream: StreamState = frame ? "playing" : "connecting";

  const sourceRef = useRef(props.source);
  const onStreamStateRef = useRef(onStreamState);
  onStreamStateRef.current = onStreamState;
  const lastReported = useRef<StreamState | null>(null);

  useEffect(() => sourceRef.current.subscribe((f) => setFrame(f)), []);

  useEffect(() => {
    if (lastReported.current === stream) return;
    lastReported.current = stream;
    onStreamStateRef.current?.(stream);
  }, [stream]);

  const health = videoHealth({ backendReachable, videoLive, frameAgeS });

  let kind: VideoOverlayKind | null = null;
  if (health === "unreachable" || health === "waiting" || health === "no_video") kind = health;
  else if (stream === "connecting") kind = "connecting"; // no frame yet: never a bare empty frame

  const text = kind ? videoOverlayText(kind, mode, frameAgeS, "canvas") : null;
  const overlayClass = kind === "connecting" ? "waiting" : kind;

  return (
    <div className="video-frame" data-health={health} data-stream={stream}>
      <SceneCanvas
        frame={frame}
        label={CANVAS_VIEW_LABEL}
        className={stream === "playing" ? "video-img" : "video-img video-img--empty"}
      />
      {text && (
        <div className={`video-overlay video-overlay--${overlayClass}`} role="status">
          <strong className="video-overlay-title">{text.title}</strong>
          {/* Unreachable: the page shell already says the backend is not reachable, once. */}
          {kind !== "unreachable" && <span className="video-overlay-detail">{text.detail}</span>}
          {text.age && <span className="video-overlay-age">{text.age}</span>}
        </div>
      )}
      {tags && <div className="video-tags">{tags}</div>}
    </div>
  );
}
