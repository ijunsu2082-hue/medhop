// Replays __fixtures__/projection.json (backend/tools/parity_traces.py projection) through projection.ts.
//
// Python side: SimLink's own focal length and camera matrix for four lenses (640x360 and 1280x720 at
// 70 degrees, plus two others), SimLink._camera for random poses (headings all round, so many points are
// behind the camera), sim_actors.project for the pixels, and for polygons (the wall, the floor, the sign
// sheet, random triangles and pentagons around the camera, often across the near plane) a reference
// Sutherland-Hodgman clip in the tool. Everything within 1e-9 relative.
import { describe, expect, it } from "vitest";
import { assertNoMismatches, compareValues, loadFixture, PARITY, ParityStats } from "../testing/fixtures";
import {
  cameraMatrix,
  clipPolygonNear,
  focalLength,
  makeCamera,
  NEAR_M,
  projectPoint,
  projectPolygon,
  worldToCamera,
  type Vec3,
} from "./projection";

interface Lens {
  width: number;
  height: number;
  hfov_deg: number;
  focal: number;
  K: number[][];
}

interface ProjectionFixture {
  cameras: Lens[];
  points: { snap: [number, number, number, number]; lens: number; world: Vec3[]; cam: number[][]; uv: number[][] }[];
  polygons: {
    name: string;
    snap: [number, number, number, number];
    lens: number;
    near: number;
    world: Vec3[];
    cam: number[][];
    clipped: number[][];
    uv: number[][];
  }[];
}

const fx = loadFixture<ProjectionFixture>("projection");

function cameraOf(snap: [number, number, number, number], lens: Lens) {
  const [x, z, heading, cam_y] = snap;
  return makeCamera({ x, z, heading, cam_y }, lens);
}

describe("the simulator camera against sim.py", () => {
  it("focal length and camera matrix for every lens", () => {
    expect(fx.cameras.map((c) => [c.width, c.height])).toEqual(
      expect.arrayContaining([
        [640, 360],
        [1280, 720],
      ]),
    );
    for (const c of fx.cameras) {
      assertNoMismatches(compareValues(focalLength(c.width, c.hfov_deg), c.focal, PARITY), "focal");
      assertNoMismatches(compareValues(cameraMatrix(c.width, c.height, c.hfov_deg), c.K, PARITY), "K");
    }
  });

  it(`world points to camera coordinates and pixels: ${fx.points.length} poses`, () => {
    const stats = new ParityStats();
    let behind = 0;
    fx.points.forEach((case_, i) => {
      const camera = cameraOf(case_.snap, fx.cameras[case_.lens]!);
      const cam = case_.world.map((p) => worldToCamera(camera, p));
      const projected = case_.world.map((p) => projectPoint(camera, p));
      behind += projected.filter((p) => !p.in_front).length;
      projected.forEach((p, k) => expect(p.depth).toBe(cam[k]![2]));
      const got = { cam, uv: projected.map((p) => [p.u, p.v]) };
      assertNoMismatches(compareValues(got, { cam: case_.cam, uv: case_.uv }, PARITY, `points[${i}]`, stats), `points[${i}]`);
    });
    expect(behind).toBeGreaterThan(50); // points behind the camera are covered (their pixels are mirrored)
    console.log(stats.summary("points"));
  });

  it(`polygons clipped at the near plane and projected: ${fx.polygons.length} cases`, () => {
    const stats = new ParityStats();
    let crossing = 0;
    let gone = 0;
    fx.polygons.forEach((case_, i) => {
      const camera = cameraOf(case_.snap, fx.cameras[case_.lens]!);
      const cam = case_.world.map((p) => worldToCamera(camera, p));
      const clipped = clipPolygonNear(cam, case_.near);
      const uv = projectPolygon(camera, case_.world, case_.near);
      if (cam.some((p) => p[2] >= case_.near) && cam.some((p) => p[2] < case_.near)) crossing += 1;
      if (clipped.length === 0) gone += 1;
      const got = { cam, clipped, uv };
      const want = { cam: case_.cam, clipped: case_.clipped, uv: case_.uv };
      assertNoMismatches(compareValues(got, want, PARITY, `polygons[${i}] ${case_.name}`, stats), `polygons[${i}]`);
    });
    expect(crossing).toBeGreaterThan(10);
    expect(gone).toBeGreaterThan(0);
    console.log(stats.summary("polygons"));
  });
});

describe("projection conventions", () => {
  it("the optical axis lands on the principal point (pixel-centre coordinates)", () => {
    const camera = makeCamera({ x: 0, z: -2, heading: 0, cam_y: 1.0 }, { width: 1280, height: 720, hfov_deg: 70 });
    const p = projectPoint(camera, [0, 1.0, 0]);
    expect([p.u, p.v, p.depth, p.in_front]).toEqual([640, 360, 2, true]);
    // the frame's left edge at the focal length's field of view
    const edge = projectPoint(camera, [-2 * Math.tan((35 * Math.PI) / 180), 1.0, 0]);
    expect(edge.u).toBeCloseTo(0, 9);
    // up in the world is up in the picture, right is right
    expect(projectPoint(camera, [0.1, 1.1, 0]).u).toBeGreaterThan(640);
    expect(projectPoint(camera, [0.1, 1.1, 0]).v).toBeLessThan(360);
  });

  it("turning right moves the scene left", () => {
    const lens = { width: 640, height: 360, hfov_deg: 70 };
    const ahead = projectPoint(makeCamera({ x: 0, z: -2, heading: 0, cam_y: 1 }, lens), [0, 1, 0]);
    const turned = projectPoint(makeCamera({ x: 0, z: -2, heading: 0.2, cam_y: 1 }, lens), [0, 1, 0]);
    expect(turned.u).toBeLessThan(ahead.u);
  });

  it("a polygon wholly behind the near plane is empty; one in front is unchanged", () => {
    const camera = makeCamera({ x: 0, z: -2, heading: Math.PI, cam_y: 1 }, { width: 640, height: 360, hfov_deg: 70 });
    expect(projectPolygon(camera, [[-0.1, 1.1, 0], [0.1, 1.1, 0], [0.1, 0.9, 0]])).toEqual([]);
    const front: Vec3[] = [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 2],
    ];
    expect(clipPolygonNear(front, NEAR_M)).toEqual(front);
  });
});
