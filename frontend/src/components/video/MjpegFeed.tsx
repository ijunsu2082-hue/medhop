import { useEffect, useRef, useState } from "react";
import { useOptionalStatus } from "../../hooks/useStatus";
import { StreamController, type StreamState } from "../../logic/streamController";
import { videoHealth } from "../../logic/videoHealth";
import { videoAlt, videoOverlayText, type VideoOverlayKind } from "../../text/videoWording";
import type { FrameSize, VideoFeedProps } from "./feedProps";

interface Props extends VideoFeedProps {
  /** The MJPEG stream's URL (the transport's camera.url). Read once per mount: it is fixed for the page's life. */
  url: string;
}

/** How often the element is sampled for a picture (a mid-play reset is noticed after two misses in a row). */
const PICTURE_SAMPLE_MS = 250;
/** onFrameSize is checked on every load and on every FRAME_SIZE_EVERY-th sample (once a second). */
const FRAME_SIZE_EVERY = 4;

// Cache-busting tokens are unique for the life of the document (also across remounts and hot reloads), so a
// new request is never answered from the browser's in-memory image list.
let streamToken = Date.now();
const nextToken = () => ++streamToken;

/**
 * Annotated MJPEG from the backend in a 16:9 frame. One <img>, one connection: the src attribute is owned by a
 * StreamController (set and removed only inside an effect, never set to ""), which aborts the old request before
 * any new one, retries a failed, stalled or mid-play broken stream with backoff, and does not re-request on
 * video_live changes.
 */
export function MjpegFeed(props: Props) {
  const { videoLive, backendReachable, tags, onFrameSize, onStreamState } = props;
  const shared = useOptionalStatus()?.status ?? null;
  const mode = props.mode !== undefined ? props.mode : (shared?.mode ?? null);
  const frameAgeS = props.frameAgeS !== undefined ? props.frameAgeS : (shared?.link.frame_age_s ?? null);
  const imgRef = useRef<HTMLImageElement>(null);
  const controllerRef = useRef<StreamController | null>(null);
  const [stream, setStream] = useState<StreamState>("connecting");
  // Whether the element has a decoded picture right now (src set and naturalWidth > 0).
  const [picture, setPicture] = useState(false);

  const urlRef = useRef(props.url);
  const reachableRef = useRef(backendReachable);
  reachableRef.current = backendReachable;
  const onFrameSizeRef = useRef(onFrameSize);
  onFrameSizeRef.current = onFrameSize;
  const onStreamStateRef = useRef(onStreamState);
  onStreamStateRef.current = onStreamState;
  const lastSize = useRef<FrameSize | null>(null);
  const lastReported = useRef<StreamState | null>(null);

  const samplePictureState = () => {
    const img = imgRef.current;
    const has = !!img && img.getAttribute("src") !== null && img.naturalWidth > 0;
    setPicture(has);
    return has;
  };

  const checkSize = () => {
    const img = imgRef.current;
    const size =
      img && img.getAttribute("src") !== null && img.naturalWidth > 0 && img.naturalHeight > 0
        ? { width: img.naturalWidth, height: img.naturalHeight }
        : null;
    const prev = lastSize.current;
    if (prev === size || (prev && size && prev.width === size.width && prev.height === size.height)) return;
    lastSize.current = size;
    onFrameSizeRef.current?.(size);
  };

  // One controller per mount. React StrictMode's dev double-mount sets and clears src within the same task, so
  // only the second mount's request reaches the network.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const c = new StreamController(urlRef.current, {
      setSrc: (url) => {
        if (url === null) img.removeAttribute("src");
        else img.setAttribute("src", url);
        samplePictureState();
        checkSize();
      },
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      onState: (s) => setStream(s),
      nextToken,
    });
    controllerRef.current = c;
    setStream("connecting");
    c.start(reachableRef.current);
    // Every 250 ms tell the controller whether the element still has a picture: a connection reset mid-play fires
    // no error event, and naturalWidth dropping to 0 is the only sign of it. The first miss already shows the
    // 'interrupted' overlay (within 250 ms of the cut); the second in a row makes the controller clear the element
    // and schedule the retry. Size changes are reported once a second (and on every load).
    let tick = 0;
    const poll = setInterval(() => {
      c.samplePicture(samplePictureState());
      tick = (tick + 1) % FRAME_SIZE_EVERY;
      if (tick === 0) checkSize();
    }, PICTURE_SAMPLE_MS);
    return () => {
      clearInterval(poll);
      c.stop(); // ends with removeAttribute("src"), which aborts the MJPEG request
      if (controllerRef.current === c) controllerRef.current = null;
    };
    // Created once per mount; the props it needs are read through refs.
  }, []);

  useEffect(() => {
    controllerRef.current?.setReachable(backendReachable);
  }, [backendReachable]);

  useEffect(() => {
    if (lastReported.current === stream) return;
    lastReported.current = stream;
    onStreamStateRef.current?.(stream);
  }, [stream]);

  const health = videoHealth({ backendReachable, videoLive, frameAgeS });

  let kind: VideoOverlayKind | null = null;
  if (health === "unreachable" || health === "waiting" || health === "no_video") kind = health;
  else if (stream === "interrupted") kind = "interrupted";
  else if (stream === "connecting") kind = "connecting"; // nothing has loaded yet: never a bare black frame
  // Playing, but the last sample found no picture (a mid-play reset): say so at once, before the controller's
  // second miss clears the element and schedules the retry.
  else if (!picture) kind = "interrupted";

  const text = kind ? videoOverlayText(kind, mode, frameAgeS) : null;
  const overlayClass = kind === "connecting" ? "waiting" : kind;

  return (
    <div className="video-frame" data-health={health} data-stream={stream}>
      <img
        ref={imgRef}
        className="video-img"
        // Chrome draws a broken-image icon and an inset border for an <img> without a src (interrupted,
        // unreachable) or whose stream was cut, whatever the alt text. So the element is hidden whenever it has no
        // picture, and the frame never depends on an overlay being opaque. (Not the hidden attribute: page CSS sets
        // display on .video-img.) The overlay explains the state; visibility also takes the element out of the
        // accessibility tree, so the alt text is only announced while a picture is shown.
        style={stream === "playing" && picture ? undefined : { visibility: "hidden" }}
        alt={stream === "playing" ? videoAlt(mode) : ""}
        onLoad={() => {
          controllerRef.current?.loaded();
          samplePictureState();
          checkSize();
        }}
        onError={() => {
          controllerRef.current?.errored();
          samplePictureState();
          checkSize();
        }}
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
