import { useState } from "react";
import type { Status } from "../../api/types";
import type { StreamState } from "../../logic/streamController";
import { videoHealth } from "../../logic/videoHealth";
import { cameraCaption, headReadout, signValue, videoRailTone, videoRailValue, type FrameSize } from "../../text/pilotWording";
import { missionStateText } from "../../text/wording";
import { VideoFeed } from "../VideoFeed";

interface Props {
  /** null while there is no status (or the backend is not reachable) */
  status: Status | null;
  /** false when neither the status socket nor the poll reaches the backend */
  backendReachable: boolean;
  /** this window's MJPEG stream state; held by the page because the command strip shows it too */
  streamState: StreamState;
  onStreamState: (state: StreamState) => void;
}

/**
 * The camera: a heading with the measured readout, the picture with nothing drawn over it in normal operation,
 * and three states under it. The caption is mode-aware and never calls the simulator picture the drone's stream.
 */
export function CameraFigure({ status, backendReachable, streamState, onStreamState }: Props) {
  const [frame, setFrame] = useState<FrameSize | null>(null);

  const videoLive = status ? status.link.video_live : null;
  const frameAgeS = status ? status.link.frame_age_s : null;
  const mode = status ? status.mode : null;
  const health = videoHealth({ backendReachable, videoLive, frameAgeS });
  // A size is only a fact about the picture while one is shown.
  const shownFrame = health === "live" || health === "delayed" ? frame : null;
  const readout = status ? headReadout(shownFrame, status.link.fps, frameAgeS) : "";
  const signInView = status ? status.vision.marker !== null : false;

  return (
    <section className="section pilot-camera" aria-labelledby="h-video">
      <div className="section-head">
        <h2 id="h-video">Camera</h2>
        {readout && <span className="section-summary">{readout}</span>}
      </div>
      <figure className="camera">
        <VideoFeed
          videoLive={videoLive}
          backendReachable={backendReachable}
          frameAgeS={frameAgeS}
          mode={mode}
          onFrameSize={setFrame}
          onStreamState={onStreamState}
          tags={health === "delayed" ? <span className="video-tag">Video delayed</span> : undefined}
        />
        {status ? (
          <dl className="camera-rail" role="status">
            <div>
              <dt>Run</dt>
              <dd className="state tone-pass">
                <span className="dot" aria-hidden="true" />
                {missionStateText(status.mission.state)}
              </dd>
            </div>
            <div>
              <dt>Station sign</dt>
              <dd className={`state ${signInView ? "tone-pass" : "tone-info"}`}>
                <span className="dot" aria-hidden="true" />
                {signValue(signInView)}
              </dd>
            </div>
            <div>
              <dt>Video</dt>
              <dd className={`state tone-${videoRailTone(health, streamState)}`}>
                <span className="dot" aria-hidden="true" />
                {videoRailValue(health, streamState, frameAgeS)}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="camera-waiting muted" role="status">
            Waiting for status.
          </p>
        )}
        <figcaption className="camera-caption">{cameraCaption(mode, shownFrame).join(" ")}</figcaption>
      </figure>
    </section>
  );
}
