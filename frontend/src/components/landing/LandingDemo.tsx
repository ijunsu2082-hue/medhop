import { Link } from "react-router-dom";
import { PlanView } from "../../scene/PlanView";
import { SceneCanvas } from "../../scene/SceneCanvas";
import type { SceneFrame } from "../../scene/drawScene";
import { DEMO, HERO } from "../../text/landingWording";

// Until the simulator engine is wired in, the demo shows one still frame: the drone on its start spot, 3.2 m from the sign.
const STILL: SceneFrame = {
  pose: { x: 0, z: -3.2, heading: 0, camY: 0.04 },
  corners: null,
  landingSpot: 0.45,
};

export function LandingDemo() {
  return (
    <div className="demo" id="demo">
      <div className="demo-actions row">
        <button type="button" className="btn btn-primary btn-lg">
          {HERO.run}
        </button>
        <Link to="/pilot">{HERO.fly}</Link>
      </div>
      <div className="demo-grid">
        <div className="demo-main">
          <figure className="demo-camera">
            <SceneCanvas frame={STILL} label={DEMO.cameraLabel} className="demo-canvas" />
            <figcaption>{DEMO.cameraCaption}</figcaption>
          </figure>
          <p className="demo-honest">{DEMO.honest}</p>
        </div>
        <div className="demo-side">
          <ol className="demo-steps">
            {DEMO.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <figure className="demo-plan">
            <PlanView x={STILL.pose.x} distance={-STILL.pose.z} heading={STILL.pose.heading} track={[]} landingSpot={0.45} className="plan" />
            <figcaption>{DEMO.planCaption}</figcaption>
          </figure>
        </div>
      </div>
    </div>
  );
}
