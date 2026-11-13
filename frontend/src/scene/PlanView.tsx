// The room from above: the station wall, the sign, the landing spot, the people and objects in the corridor,
// the drone with the lane it needs, its view and where it has been. This shows the simulator's truth, not
// what the camera sees. People wear the same colours as in the camera view (drawScene.ts CLOTHES), by index.

import { useId } from "react";

/** An actor as the status reports it (simulator truth): its footprint on the floor. A "person" is drawn round. */
export interface PlanActor {
  kind: string;
  x_m: number;
  distance_m: number;
  width_m: number;
  depth_m: number;
}

interface Props {
  /** metres along the wall; 0 is the sign's centre line */
  x: number;
  /** metres from the wall (positive) */
  distance: number;
  /** radians; 0 faces the wall, positive turns right */
  heading: number;
  /** earlier positions, oldest first */
  track: readonly { x: number; distance: number }[];
  /** metres from the wall where the run lands; null leaves it out */
  landingSpot: number | null;
  /** the people and objects in the corridor */
  actors: readonly PlanActor[];
  className?: string;
}

// The drawing covers 5 m across and 5 m back from the wall (the scenarios start 4.2 m out), 50 units to the metre.
const SCALE = 50;
const HALF_WIDTH_M = 2.5;
const DEPTH_M = 5;
const TOP = 16;
const W = HALF_WIDTH_M * 2 * SCALE;
const H = TOP + DEPTH_M * SCALE + 14;

/** The lane the drone needs (the flight logic's lane_half_m), and how far ahead it is drawn. */
const LANE_HALF_M = 0.55;
const LANE_AHEAD_M = 3;
/** The camera's 70 degree view, drawn this long. */
const VIEW_M = 1.2;
const HALF_VIEW = (35 * Math.PI) / 180;

const px = (x: number) => (x + HALF_WIDTH_M) * SCALE;
const py = (distance: number) => TOP + distance * SCALE;
const pts = (list: readonly (readonly [number, number])[]) => list.map(([a, b]) => `${a},${b}`).join(" ");

export function PlanView({ x, distance, heading, track, landingSpot, actors, className }: Props) {
  const clipId = `plan-room-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const cx = px(x);
  const cy = py(distance);
  // Ahead and to the right of the drone, in drawing units per metre (the drawing's y grows away from the wall).
  const ahead = [Math.sin(heading) * SCALE, -Math.cos(heading) * SCALE] as const;
  const right = [Math.cos(heading) * SCALE, Math.sin(heading) * SCALE] as const;
  const at = (fwd: number, side: number) => [cx + ahead[0] * fwd + right[0] * side, cy + ahead[1] * fwd + right[1] * side] as const;
  const ray = (offset: number) => {
    const a = heading + offset;
    return [cx + Math.sin(a) * VIEW_M * SCALE, cy - Math.cos(a) * VIEW_M * SCALE] as const;
  };
  const lane = pts([at(0, -LANE_HALF_M), at(LANE_AHEAD_M, -LANE_HALF_M), at(LANE_AHEAD_M, LANE_HALF_M), at(0, LANE_HALF_M)]);
  const view = pts([[cx, cy], ray(-HALF_VIEW), ray(HALF_VIEW)]);
  const deg = (heading * 180) / Math.PI;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Plan view: the drone is ${distance.toFixed(1)} metres from the station wall`}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={TOP} width={W} height={H - TOP} />
        </clipPath>
      </defs>
      <rect className="plan-floor" x={0} y={TOP} width={W} height={H - TOP} />
      <line className="plan-axis" x1={px(0)} y1={TOP} x2={px(0)} y2={H} />
      {/* Both faint bands first, then their edges, so neither hides the other's. */}
      <g clipPath={`url(#${clipId})`}>
        <polygon className="plan-band" points={view} />
        <polygon className="plan-band plan-band--lane" points={lane} />
        <polygon className="plan-view" points={view} />
        <polygon className="plan-lane" points={lane} />
      </g>
      {landingSpot !== null && <circle className="plan-spot" cx={px(0)} cy={py(landingSpot)} r={0.15 * SCALE} />}
      {track.length > 1 && <polyline className="plan-track" points={pts(track.map((p) => [px(p.x), py(p.distance)]))} />}
      {actors.map((a, i) =>
        a.kind === "person" ? (
          <circle
            key={i}
            className={`plan-actor plan-person plan-cloth-${(i % 3) + 1}`}
            cx={px(a.x_m)}
            cy={py(a.distance_m)}
            r={(Math.max(a.width_m, a.depth_m) / 2) * SCALE}
          />
        ) : (
          <rect
            key={i}
            className="plan-actor plan-object"
            x={px(a.x_m - a.width_m / 2)}
            y={py(a.distance_m - a.depth_m / 2)}
            width={a.width_m * SCALE}
            height={a.depth_m * SCALE}
          />
        ),
      )}
      <g transform={`translate(${cx} ${cy}) rotate(${deg})`}>
        <polygon className="plan-drone" points="0,-9 7,7 0,3 -7,7" />
      </g>
      <line className="plan-wall" x1={0} y1={TOP} x2={W} y2={TOP} />
      <line className="plan-sign" x1={px(-0.105)} y1={TOP} x2={px(0.105)} y2={TOP} />
      <text className="plan-text" x={px(0)} y={TOP - 6} textAnchor="middle">
        sign
      </text>
      <line className="plan-scale" x1={12} y1={H - 9} x2={12 + SCALE} y2={H - 9} />
      <text className="plan-text" x={12 + SCALE + 6} y={H - 5}>
        1 m
      </text>
    </svg>
  );
}
