// The camera view's geometry: what shapes and labels a frame produces (buildScene is pure; painting them is
// not tested here, there is no canvas in the node environment). The sign must land where the engine's
// detector sees it, the actors must be drawn as the simulator fills them (after the sign, farthest first,
// filling the box the flight logic is given), and the flight logic's marks must say what it saw.
import { describe, expect, it } from "vitest";
import { makeCamera, type Pixel } from "../engine/camera/projection";
import { highQualitySimConfig, type SimSnapshot } from "../engine/drone/sim";
import { Actor, actorBox, actorDrawOrder } from "../engine/drone/simActors";
import { signCorners } from "../engine/vision/detector";
import {
  buildScene,
  FRAME_H,
  FRAME_W,
  LENS,
  obstacleLabel,
  type PathShape,
  type Pt,
  type Rect,
  type SceneFrame,
  type SceneObstacle,
  type Shape,
  type TextShape,
} from "./drawScene";

const SIM = highQualitySimConfig();
const DEG = Math.PI / 180;

function view(distance: number, x = 0, headingDeg = 0, actors: readonly Actor[] = [], camY = 1.04): SimSnapshot {
  return { x, z: -distance, heading: headingDeg * DEG, cam_y: camY, marker_hidden: false, actors, t: 0 };
}

function frame(v: SimSnapshot, more: Partial<SceneFrame> = {}): SceneFrame {
  return { view: v, marker: null, obstacles: [], landingSpot: 0.45, ...more };
}

const paths = (shapes: Shape[], part: Shape["part"]) =>
  shapes.filter((s): s is PathShape => s.type === "path" && s.part === part);
const texts = (shapes: Shape[], part: Shape["part"]) =>
  shapes.filter((s): s is TextShape => s.type === "text" && s.part === part);
const centre = (p: Pixel): Pt => [p[0] + 0.5, p[1] + 0.5];

function bounds(points: readonly Pt[]): Rect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/** The camera, as the frame's snapshot places it. */
const cameraOf = (v: SimSnapshot) => makeCamera(v, LENS);

describe("obstacle labels", () => {
  it("name the kind and the distance, rounded to one decimal", () => {
    expect(obstacleLabel({ kind: "person", distance_m: 2.64 })).toBe("person 2.6 m");
    expect(obstacleLabel({ kind: "person", distance_m: 2.66 })).toBe("person 2.7 m");
    expect(obstacleLabel({ kind: "person", distance_m: 1.8 })).toBe("person 1.8 m");
    expect(obstacleLabel({ kind: "object", distance_m: 3 })).toBe("object 3.0 m");
    expect(obstacleLabel({ kind: "object", distance_m: 0.94 })).toBe("object 0.9 m");
  });

  it('say "under 2.5 m" when the base is below the picture', () => {
    expect(obstacleLabel({ kind: "person", distance_m: null })).toBe("person, under 2.5 m");
    expect(obstacleLabel({ kind: "object", distance_m: null })).toBe("object, under 2.5 m");
  });

  it("are what the frame's labels say, one per obstacle, in order", () => {
    const obstacles: SceneObstacle[] = [
      { kind: "person", box: [0.1, 0.3, 0.2, 0.8], distance_m: 2.64, in_lane: false },
      { kind: "object", box: [0.6, 0.5, 0.8, 1.0], distance_m: null, in_lane: true },
    ];
    const labels = texts(buildScene(frame(view(3.5), { obstacles })), "label");
    expect(labels.map((t) => t.text)).toEqual(["person 2.6 m", "object, under 2.5 m"]);
    expect(labels.map((t) => t.index)).toEqual([0, 1]);
  });
});

describe("the sign", () => {
  const poses: [string, SimSnapshot][] = [
    ["square on, hovering", view(3.5)],
    ["close, off to the side, turned", view(1.2, 0.3, -10)],
    ["far, on the ground, turned the other way", view(4.2, -0.4, 12, [], 0.04)],
    ["high and turned well away", view(2.0, 0.1, 25, [], 1.6)],
  ];

  for (const [name, v] of poses) {
    it(`is drawn where the engine's detector sees it: ${name}`, () => {
      const marker = paths(buildScene(frame(v)), "marker");
      expect(marker).toHaveLength(1);
      const want = signCorners(SIM, v).pixels.map(centre);
      expect(marker[0]!.points).toHaveLength(4);
      marker[0]!.points.forEach((p, i) => {
        expect(p[0]).toBeCloseTo(want[i]![0], 9);
        expect(p[1]).toBeCloseTo(want[i]![1], 9);
      });
    });
  }

  it("is left out while the simulator hides it", () => {
    const shapes = buildScene(frame({ ...view(3.5), marker_hidden: true }));
    expect(paths(shapes, "marker")).toEqual([]);
    expect(paths(shapes, "sign")).toEqual([]);
    expect(texts(shapes, "sign")).toEqual([]);
  });
});

describe("people and objects", () => {
  it("are drawn after the sign, so a person between the camera and the sign hides it", () => {
    const person = new Actor({ kind: "person", x_m: 0, distance_m: 1.5 });
    const shapes = buildScene(frame(view(3.5, 0, 0, [person])));
    const lastSign = shapes.reduce((last, s, i) => (s.part === "sign" || s.part === "marker" ? i : last), -1);
    const firstActor = shapes.findIndex((s) => s.part === "actor");
    expect(lastSign).toBeGreaterThan(0);
    expect(firstActor).toBeGreaterThan(lastSign);
    // and it really stands in front of the marker in the picture
    const marker = bounds(paths(shapes, "marker")[0]!.points);
    const figure = bounds(paths(shapes, "actor").flatMap((s) => [...s.points]));
    expect(overlaps(figure, marker)).toBe(true);
  });

  it("are drawn farthest first, in the simulator's order", () => {
    const actors = [
      new Actor({ kind: "person", x_m: 0.4, distance_m: 2.4 }),
      new Actor({ kind: "object", x_m: -0.6, distance_m: 0.8, width_m: 0.6, depth_m: 0.4, height_m: 0.9 }),
      new Actor({ kind: "person", x_m: -0.2, distance_m: 1.6 }),
    ];
    const v = view(3.6, 0, 0, actors);
    const want = actorDrawOrder(actors, cameraOf(v).position);
    expect(want).toEqual([1, 2, 0]); // the test only means something if this is not the list's own order
    const seen: number[] = [];
    for (const s of paths(buildScene(frame(v)), "actor")) if (!seen.includes(s.index!)) seen.push(s.index!);
    expect(seen).toEqual(want);
  });

  it("are drawn after the room and the landing spot, and before the flight logic's marks", () => {
    const person = new Actor({ kind: "person", x_m: 0.2, distance_m: 1.5 });
    const v = view(3.5, 0, 0, [person]);
    const shapes = buildScene(
      frame(v, {
        marker: signCorners(SIM, view(3.5)).pixels,
        obstacles: [{ kind: "person", box: [0.5, 0.1, 0.7, 1.0], distance_m: null, in_lane: true }],
      }),
    );
    const parts = shapes.map((s) => s.part);
    const last = (part: Shape["part"]) => parts.lastIndexOf(part);
    const first = (part: Shape["part"]) => parts.indexOf(part);
    expect(last("room")).toBeLessThan(first("landing"));
    expect(last("landing")).toBeLessThan(first("actor"));
    expect(last("actor")).toBeLessThan(first("tracking"));
    expect(last("tracking")).toBeLessThan(first("obstacle"));
    expect(last("obstacle")).toBeLessThan(first("label"));
  });

  it("a person fills the box the simulator hands the flight logic", () => {
    const person = new Actor({ kind: "person", x_m: 0.5, distance_m: 1.0 });
    const v = view(4.2, 0, 5, [person]);
    const cam = cameraOf(v);
    const box = actorBox(person, cam.position, cam.rot, cam.K, FRAME_W, FRAME_H)!;
    expect(box[1]).toBeGreaterThan(0); // wholly in the picture, so nothing is clipped
    expect(box[3]).toBeLessThan(1);
    const figure = bounds(paths(buildScene(frame(v)), "actor").flatMap((s) => [...s.points]));
    expect(figure.x0).toBeCloseTo(box[0] * FRAME_W + 0.5, 6);
    expect(figure.y0).toBeCloseTo(box[1] * FRAME_H + 0.5, 6);
    expect(figure.x1).toBeCloseTo(box[2] * FRAME_W + 0.5, 6);
    expect(figure.y1).toBeCloseTo(box[3] * FRAME_H + 0.5, 6);
  });

  it("are filled in the mid grey and outlined in ink", () => {
    const actors = [
      new Actor({ kind: "person", x_m: -0.5, distance_m: 1.5 }),
      new Actor({ kind: "object", x_m: 0.6, distance_m: 1.2, width_m: 0.6, depth_m: 0.4, height_m: 0.9 }),
    ];
    const shapes = paths(buildScene(frame(view(3.5, 0, 0, actors))), "actor");
    for (const index of [0, 1]) {
      const mine = shapes.filter((s) => s.index === index);
      expect(mine.some((s) => s.fill === "mid")).toBe(true);
      expect(mine.some((s) => s.stroke === "ink")).toBe(true);
      expect(mine.every((s) => s.fill === null || s.fill === "mid")).toBe(true);
    }
  });

  it("are not drawn when they are behind the camera", () => {
    const behind = new Actor({ kind: "person", x_m: 0, distance_m: 4.5 });
    expect(paths(buildScene(frame(view(3.5, 0, 0, [behind]))), "actor")).toEqual([]);
  });
});

describe("the flight logic's marks", () => {
  const box = (s: PathShape) => bounds(s.points);

  it("put a box round each obstacle, just outside it, heavier when it is in the lane", () => {
    const obstacles: SceneObstacle[] = [
      { kind: "person", box: [0.1, 0.3, 0.2, 0.8], distance_m: 2.6, in_lane: false },
      { kind: "person", box: [0.4, 0.2, 0.6, 0.9], distance_m: 1.9, in_lane: true },
    ];
    const marks = paths(buildScene(frame(view(3.5), { obstacles }), { uiScale: 1 }), "obstacle");
    expect(marks.map((s) => s.index)).toEqual([0, 1]);
    expect(marks.every((s) => s.stroke === "ink" && s.fill === null && s.closed)).toBe(true);
    expect(marks[1]!.width).toBeGreaterThan(marks[0]!.width);
    obstacles.forEach((o, i) => {
      const drawn = box(marks[i]!);
      expect(drawn.x0).toBeLessThan(o.box[0] * FRAME_W);
      expect(drawn.y0).toBeLessThan(o.box[1] * FRAME_H);
      expect(drawn.x1).toBeGreaterThan(o.box[2] * FRAME_W);
      expect(drawn.y1).toBeGreaterThan(o.box[3] * FRAME_H);
      expect(drawn.x0).toBeGreaterThan(o.box[0] * FRAME_W - 10);
    });
  });

  it("keep the outline round the tracked sign, outside the marker", () => {
    const v = view(3.5);
    const corners = signCorners(SIM, v).pixels;
    const shapes = buildScene(frame(v, { marker: corners }));
    const ring = paths(shapes, "tracking");
    expect(ring).toHaveLength(1);
    const marker = bounds(paths(shapes, "marker")[0]!.points);
    const outline = bounds(ring[0]!.points);
    expect(outline.x0).toBeLessThan(marker.x0);
    expect(outline.y0).toBeLessThan(marker.y0);
    expect(outline.x1).toBeGreaterThan(marker.x1);
    expect(outline.y1).toBeGreaterThan(marker.y1);
    expect(paths(buildScene(frame(v)), "tracking")).toEqual([]);
  });

  it("set each label on a plate inside the picture, clear of the sign's outline and of each other", () => {
    // The landing page's still: a person close in front, a little left of the sign, and a few made-up neighbours.
    const person = new Actor({ kind: "person", x_m: -0.4, distance_m: 1.55 });
    const v = view(3.5, 0, 0, [person]);
    const cam = cameraOf(v);
    const real = actorBox(person, cam.position, cam.rot, cam.K, FRAME_W, FRAME_H)!;
    const obstacles: SceneObstacle[] = [
      { kind: "person", box: real, distance_m: null, in_lane: true },
      { kind: "object", box: [0.52, 0.42, 0.6, 0.62], distance_m: 2.2, in_lane: false },
      { kind: "person", box: [0.47, 0.6, 0.53, 0.98], distance_m: 2.9, in_lane: true },
    ];
    for (const uiScale of [1, 1.6, 3.6]) {
      const shapes = buildScene(frame(v, { marker: signCorners(SIM, v).pixels, obstacles }), { uiScale });
      const ring = bounds(paths(shapes, "tracking")[0]!.points);
      const plates = paths(shapes, "label").map((s) => bounds(s.points));
      expect(plates).toHaveLength(obstacles.length);
      plates.forEach((p, i) => {
        expect(p.x0, `label ${i} at ${uiScale}`).toBeGreaterThanOrEqual(0);
        expect(p.y0).toBeGreaterThanOrEqual(0);
        expect(p.x1).toBeLessThanOrEqual(FRAME_W);
        expect(p.y1).toBeLessThanOrEqual(FRAME_H);
        expect(overlaps(p, ring), `label ${i} at ${uiScale} on the sign's outline`).toBe(false);
        plates.slice(i + 1).forEach((q) => expect(overlaps(p, q)).toBe(false));
      });
      // the text sits on its plate
      texts(shapes, "label").forEach((t, i) => {
        expect(t.x).toBeGreaterThan(plates[i]!.x0);
        expect(t.y).toBeGreaterThan(plates[i]!.y0);
        expect(t.y).toBeLessThan(plates[i]!.y1);
      });
    }
  });

  it("put the label above its box when there is room", () => {
    const obstacles: SceneObstacle[] = [{ kind: "object", box: [0.2, 0.5, 0.3, 0.8], distance_m: 2.1, in_lane: false }];
    const shapes = buildScene(frame(view(3.5), { obstacles }), { uiScale: 1 });
    const plate = bounds(paths(shapes, "label")[0]!.points);
    const drawn = bounds(paths(shapes, "obstacle")[0]!.points);
    expect(plate.y1).toBeLessThanOrEqual(drawn.y0);
    expect(plate.x0).toBeCloseTo(drawn.x0 - paths(shapes, "obstacle")[0]!.width / 2, 6);
  });
});
