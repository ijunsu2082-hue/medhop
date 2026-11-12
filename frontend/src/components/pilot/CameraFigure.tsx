import { useState } from "react";
import type { Status } from "../../api/types";
import type { StreamState } from "../../logic/streamController";
import { videoHealth } from "../../logic/videoHealth";
import { cameraCaption, headReadout, signValue, videoRailTone, videoRailValue, type FrameSize } from "../../text/pilotWording";
import { missionStateText } from "../../text/wording";
import { IconStop } from "../Icons";
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
 * The camera instrument: a head rail (title, mode, measured readout), the picture with nothing drawn over it in
 * normal operation, an emergency-stop band while the stop is latched, and a three-cell status rail. The caption
 * under it is mode-aware and never calls the simulator picture the drone's stream.
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
  const videoTone = videoRailTone(health, streamState);
  const signInView = status ? status.vision.marker !== null : false;

  return (
    <div className="pilot-camera">
      <figure className="camera on-console" aria-labelledby="h-video">
        <div className="camera-head">
          <h2 id="h-video">Camera</h2>
          {mode === "sim" && <span className="stamp">Simulator</span>}
          {mode === "real" && <span className="stamp stamp--amber">Real drone</span>}
          {readout && <span className="camera-readout data">{readout}</span>}
        </div>
        <VideoFeed
          videoLive={videoLive}
          backendReachable={backendReachable}
          frameAgeS={frameAgeS}
          mode={mode}
          onFrameSize={setFrame}
          onStreamState={onStreamState}
          chips={health === "delayed" ? <span className="video-tag">Video delayed</span> : undefined}
        />
        {status?.pilot.estop_active && (
          <div className="camera-estop">
            <IconStop size={20} />
            <span>Emergency stop active</span>
          </div>
        )}
        <div className="camera-rail" role="status">
          {status ? (
            <>
              <div className="camera-cell">
                <span className="camera-legend">Run</span>
                <span className="camera-value">
                  <span className="status-sq" aria-hidden="true" />
                  <span>{missionStateText(status.mission.state)}</span>
                </span>
              </div>
              <div className="camera-cell">
                <span className="camera-legend">Station sign</span>
                <span className={`camera-value${signInView ? " tone-pass" : " tone-info"}`}>
                  <span className={`status-sq${signInView ? "" : " status-sq--hollow"}`} aria-hidden="true" />
                  <span>{signValue(signInView)}</span>
                </span>
              </div>
              <div className="camera-cell">
                <span className="camera-legend">Video</span>
                <span className={`camera-value tone-${videoTone}`}>
                  <span className="status-sq" aria-hidden="true" />
                  <span>{videoRailValue(health, streamState, frameAgeS)}</span>
                </span>
              </div>
            </>
          ) : (
            <div className="camera-cell">
              <span className="camera-value tone-info">
                <span className="status-sq status-sq--hollow" aria-hidden="true" />
                <span>{backendReachable ? "Waiting for status" : "Backend not reachable"}</span>
              </span>
            </div>
          )}
        </div>
      </figure>
      <p className="camera-caption">{cameraCaption(mode, shownFrame).join(" ")}</p>
    </div>
  );
}
