import { useEffect, useRef, useState } from "react";
import { apiUrl } from "../api/config";

interface Props {
  /** null while no status has arrived yet */
  videoLive: boolean | null;
  backendReachable: boolean;
}

const RETRY_STEPS_MS = [1000, 2000, 3000, 5000];

/**
 * Annotated MJPEG from the backend in a 16:9 frame. The <img> is re-requested (cache-busted) after a stream
 * error with a short backoff, and whenever `link.video_live` goes from false to true.
 */
export function VideoFeed({ videoLive, backendReachable }: Props) {
  const [nonce, setNonce] = useState(0);
  const [streamError, setStreamError] = useState(false);
  const attempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasLive = useRef(videoLive);
  const wasReachable = useRef(backendReachable);

  // Re-request the stream only on real recoveries (false -> true), not on first load.
  useEffect(() => {
    if (videoLive === true && wasLive.current === false) {
      attempts.current = 0;
      setNonce((n) => n + 1);
    }
    wasLive.current = videoLive;
  }, [videoLive]);

  useEffect(() => {
    if (backendReachable && !wasReachable.current) {
      attempts.current = 0;
      setNonce((n) => n + 1);
    }
    wasReachable.current = backendReachable;
  }, [backendReachable]);

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    },
    [],
  );

  const onError = () => {
    setStreamError(true);
    if (retryTimer.current) return;
    const delay = RETRY_STEPS_MS[Math.min(attempts.current, RETRY_STEPS_MS.length - 1)]!;
    attempts.current += 1;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = null;
      setNonce((n) => n + 1);
    }, delay);
  };

  const onLoad = () => {
    attempts.current = 0;
    setStreamError(false);
  };

  const showNoVideo = !backendReachable || videoLive !== true;
  let detail = "";
  if (!backendReachable) detail = "Backend not reachable.";
  else if (videoLive === null) detail = "Waiting for status from the backend.";
  else if (!videoLive) detail = "The drone camera is not sending frames.";

  return (
    <div className="video-frame">
      {backendReachable && (
        <img
          key={nonce}
          className="video-img"
          src={`${apiUrl("/video.mjpg")}?r=${nonce}`}
          alt="Annotated drone camera view: station sign outline, advisory person boxes and run state"
          onError={onError}
          onLoad={onLoad}
        />
      )}
      {showNoVideo && (
        <div className="video-overlay" role="status">
          <strong>No video</strong>
          <span>{detail}</span>
        </div>
      )}
      {!showNoVideo && streamError && (
        <div className="video-overlay video-overlay-soft" role="status">
          <strong>Video stream interrupted</strong>
          <span>Reconnecting to the stream.</span>
        </div>
      )}
    </div>
  );
}
