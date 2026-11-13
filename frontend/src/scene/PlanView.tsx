// The room from above: the station wall, the sign, the landing spot, the drone and where it has been.
// This shows the simulator's true position, not what the camera sees.

interface Props {
  /** metres along the wall; 0 is the sign's centre line */
  x: number;
  /** metres from the wall (positive) */
  distance: number;
  /** radians; 0 faces the wall, positive turns right */
  heading: number;
  /** earlier positions, oldest first */
  track: readonly { x: number; distance: number }[];
  /** metres from the wall where the run lands */
  landingSpot: number;
  className?: string;
}

// The drawing covers 4.4 m across and 4.4 m back from the wall, at 50 units to the metre.
const SCALE = 50;
const HALF_WIDTH_M = 2.2;
const DEPTH_M = 4.2;
const TOP = 16;
const W = HALF_WIDTH_M * 2 * SCALE;
const H = TOP + DEPTH_M * SCALE + 12;

const px = (x: number) => (x + HALF_WIDTH_M) * SCALE;
const py = (distance: number) => TOP + distance * SCALE;

export function PlanView({ x, distance, heading, track, landingSpot, className }: Props) {
  const cx = px(x);
  const cy = py(distance);
  // The camera's 70 degree view, drawn 1.2 m long.
  const ray = (offset: number) => {
    const a = heading + offset;
    return `${cx + Math.sin(a) * 1.2 * SCALE},${cy - Math.cos(a) * 1.2 * SCALE}`;
  };
  const half = (35 * Math.PI) / 180;
  const points = track.map((p) => `${px(p.x)},${py(p.distance)}`).join(" ");
  const deg = (heading * 180) / Math.PI;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Plan view: the drone is ${distance.toFixed(1)} metres from the station wall`}
    >
      <line className="plan-wall" x1={0} y1={TOP} x2={W} y2={TOP} />
      <line className="plan-sign" x1={px(-0.105)} y1={TOP} x2={px(0.105)} y2={TOP} />
      <text className="plan-text" x={px(0)} y={TOP - 6} textAnchor="middle">
        sign
      </text>
      <line className="plan-axis" x1={px(0)} y1={TOP} x2={px(0)} y2={H} />
      <circle className="plan-spot" cx={px(0)} cy={py(landingSpot)} r={0.15 * SCALE} />
      {track.length > 1 && <polyline className="plan-track" points={points} />}
      <polygon className="plan-view" points={`${cx},${cy} ${ray(-half)} ${ray(half)}`} />
      <g transform={`translate(${cx} ${cy}) rotate(${deg})`}>
        <polygon className="plan-drone" points="0,-9 7,7 0,3 -7,7" />
      </g>
      <line className="plan-scale" x1={12} y1={H - 8} x2={12 + SCALE} y2={H - 8} />
      <text className="plan-text" x={12 + SCALE + 6} y={H - 4}>
        1 m
      </text>
    </svg>
  );
}
