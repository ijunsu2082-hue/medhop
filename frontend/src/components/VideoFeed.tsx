// The camera picture, from this build's transport: the MJPEG stream from the Python backend, or the simulator's
// view drawn in this page. The choice is the transport's (fixed when the site is built), never a reaction to a
// failure: a page whose stream fails shows that it failed, it does not switch to a drawing.

import { lazy, Suspense } from "react";
import { getTransport } from "../transport";
import type { VideoFeedProps } from "./video/feedProps";
import { MjpegFeed } from "./video/MjpegFeed";

export type { FrameSize, VideoFeedProps } from "./video/feedProps";

// The canvas feed draws with the scene module, which is built on the in-page simulator's geometry. Only a browser
// build includes it (the same build-time check as transport/index.ts), so a Python build carries none of it.
const CanvasFeed =
  import.meta.env.VITE_BACKEND === "browser"
    ? lazy(() => import("./video/CanvasFeed").then((m) => ({ default: m.CanvasFeed })))
    : null;

export function VideoFeed(props: VideoFeedProps) {
  const camera = getTransport().camera;
  if (camera.kind === "mjpeg") return <MjpegFeed {...props} url={camera.url} />;
  if (!CanvasFeed) throw new Error("This build has no canvas feed, but its transport draws the camera on a canvas");
  return (
    // Shown only while the canvas feed's code loads, the moment after the page opens.
    <Suspense fallback={<div className="video-frame" data-stream="connecting" />}>
      <CanvasFeed {...props} source={camera} />
    </Suspense>
  );
}
