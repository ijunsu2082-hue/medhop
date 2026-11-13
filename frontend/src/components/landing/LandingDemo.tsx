import { Link } from "react-router-dom";
import { cameraExtrinsics } from "../../engine/camera/projection";
import { highQualitySimConfig, SimLink } from "../../engine/drone/sim";
import { Actor, actorBox } from "../../engine/drone/simActors";
import { SignDetector } from "../../engine/vision/detector";
import { PlanView } from "../../scene/PlanView";
import { SceneCanvas } from "../../scene/SceneCanvas";
import type { SceneFrame } from "../../scene/drawScene";
import { DEMO, HERO } from "../../text/landingWording";

// Until the simulator engine is wired in, the demo shows one still frame: the drone hovering 3.5 m from the
// wall, holding for a person who stands 1.55 m from the wall, a little left of the line to the sign. The
// view is the simulator's own snapshot, the sign's corners come from the browser detector, and the box is
// the one the simulator hands the flight logic. Its feet are below the picture, so the flight logic
// (mission/avoid.py estimate) reads it as very close, and in the lane.
const SIM = highQualitySimConfig({ actors: [new Actor({ kind: "person", x_m: -0.4, distance_m: 1.55 })] });
const LINK = new SimLink(SIM, { clock: () => 0 });
const VIEW = LINK.testSnapshot(3.5);
const CAMERA = cameraExtrinsics(VIEW);
const BOX = actorBox(VIEW.actors[0]!, CAMERA.position, CAMERA.rot, LINK.K, SIM.width, SIM.height);

const STILL: SceneFrame = {
  view: VIEW,
  marker: new SignDetector(SIM).detect(VIEW)?.corners ?? null,
  obstacles: BOX ? [{ kind: "person", box: BOX, distance_m: null, in_lane: true }] : [],
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
            <PlanView
              x={STILL.view.x}
              distance={-STILL.view.z}
              heading={STILL.view.heading}
              track={[]}
              landingSpot={STILL.landingSpot}
              actors={STILL.view.actors.map((a) => a.asStatus())}
              className="plan"
            />
            <figcaption>{DEMO.planCaption}</figcaption>
          </figure>
        </div>
      </div>
    </div>
  );
}
