import { describe, expect, it } from "vitest";
import { NO_VIDEO_AFTER_S, videoHealth } from "./videoHealth";

const on = { backendReachable: true };

describe("videoHealth", () => {
  it("is unreachable when the backend is not reachable, whatever the status says", () => {
    expect(videoHealth({ backendReachable: false, videoLive: true, frameAgeS: 0.1 })).toBe("unreachable");
    expect(videoHealth({ backendReachable: false, videoLive: null, frameAgeS: null })).toBe("unreachable");
  });

  it("is waiting before any status has arrived", () => {
    expect(videoHealth({ ...on, videoLive: null, frameAgeS: undefined })).toBe("waiting");
  });

  it("is live when the backend says the video is live", () => {
    expect(videoHealth({ ...on, videoLive: true, frameAgeS: 0.05 })).toBe("live");
    expect(videoHealth({ ...on, videoLive: true, frameAgeS: null })).toBe("live");
  });

  it("is delayed when frames are late but not yet 2 s old", () => {
    expect(NO_VIDEO_AFTER_S).toBe(2.0);
    expect(videoHealth({ ...on, videoLive: false, frameAgeS: 0.8 })).toBe("delayed");
    expect(videoHealth({ ...on, videoLive: false, frameAgeS: 2.0 })).toBe("delayed");
  });

  it("is no_video when frames are older than 2 s or the age is unknown", () => {
    expect(videoHealth({ ...on, videoLive: false, frameAgeS: 2.4 })).toBe("no_video");
    expect(videoHealth({ ...on, videoLive: false, frameAgeS: null })).toBe("no_video");
    expect(videoHealth({ ...on, videoLive: false, frameAgeS: undefined })).toBe("no_video");
    expect(videoHealth({ ...on, videoLive: false, frameAgeS: Number.NaN })).toBe("no_video");
    expect(videoHealth({ ...on, videoLive: false, frameAgeS: Number.POSITIVE_INFINITY })).toBe("no_video");
  });
});
