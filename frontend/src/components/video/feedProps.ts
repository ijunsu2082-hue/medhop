// The props every camera feed takes (components/VideoFeed.tsx picks the feed from the transport).

import type { ReactNode } from "react";
import type { StreamState } from "../../logic/streamController";

export type FrameSize = { width: number; height: number };

export interface VideoFeedProps {
  /** null while no status has arrived yet */
  videoLive: boolean | null;
  backendReachable: boolean;
  /** link.frame_age_s: age of the newest frame the backend has, in seconds. When the prop is left out, the value
   * from the shared status is used. */
  frameAgeS?: number | null;
  /** When the prop is left out, the mode from the shared status is used, so the wording is never the drone's in
   * the simulator. */
  mode?: "sim" | "real" | null;
  /** tags drawn over the picture (the Pilot page passes the "video delayed" tag here) */
  tags?: ReactNode;
  /** natural size of the picture, or null when there is none; called only when it changes */
  onFrameSize?: (size: FrameSize | null) => void;
  /** called when the stream state changes */
  onStreamState?: (state: StreamState) => void;
}
