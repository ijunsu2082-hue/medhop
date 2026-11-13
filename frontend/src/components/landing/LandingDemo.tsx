// The landing page's live demo: one automatic station run in the simulator inside this page, with the Care and
// Caregiver side of it beside the flight. It talks to the in-page backend the same way the app's pages do: the
// status stream, the control link (a run needs a pilot connected, and this page is the pilot) and the API.
// What it shows is decided in logic/demo.ts. LandingPage.tsx loads this file only in the browser build.

import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { blockersFrom, errorText, requestVia } from "../../api/client";
import { useControlSocket } from "../../hooks/useControlSocket";
import { useStatus } from "../../hooks/useStatus";
import { arrivalLine } from "../../logic/care";
import {
  RUN_ACTIVE,
  demoDose,
  demoLine,
  demoPhase,
  landAction,
  landReply,
  onGround,
  readyToRun,
  startDemoRun,
  stepOf,
  stepStates,
  type DemoCall,
} from "../../logic/demo";
import { PlanView } from "../../scene/PlanView";
import { SceneCanvas } from "../../scene/SceneCanvas";
import type { SceneFrame } from "../../scene/drawScene";
import { DEMO, HERO } from "../../text/landingWording";
import { blockerText, doseStatusLine } from "../../text/wording";
import { getTransport } from "../../transport";
import { CorridorSelect } from "../pilot/Avoidance";

const call: DemoCall = (method, path, body) => requestVia(getTransport(), method, path, body);

/** Where the plan view puts the drone before the first status arrives. */
const START = { x_m: 0, distance_m: 2.5, heading_deg: 0, altitude_m: 0, airborne: false };
/** A new point is added to the drawn track once the drone has moved this far. */
const TRACK_STEP_M = 0.03;
const TRACK_MAX = 900;

/** The simulated camera. It keeps the frames to itself, so the rest of the demo is not redrawn 15 times a second. */
function DemoCamera() {
  const [frame, setFrame] = useState<SceneFrame | null>(null);
  useEffect(() => {
    const camera = getTransport().camera;
    return camera.kind === "canvas" ? camera.subscribe(setFrame) : undefined;
  }, []);
  return <SceneCanvas frame={frame} label={DEMO.cameraLabel} className="demo-canvas" />;
}

export function LandingDemo() {
  const { status } = useStatus();
  const control = useControlSocket();
  const simulator = getTransport().simulator;
  const [run, setRun] = useState<{ runId: string; doseId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Stop was pressed on this page, and the drone may still have to be landed. */
  const [stopping, setStopping] = useState(false);
  const [stoppedHere, setStoppedHere] = useState(false);
  const [fast, setFast] = useState(false);
  const [sending, setSending] = useState(false);
  const landSentAt = useRef<number | null>(null);
  const groundedSince = useRef<number | null>(null);
  const furthest = useRef<number | null>(null);
  const track = useRef<{ x: number; distance: number }[]>([]);
  const ids = useId();

  const mission = status?.mission ?? null;
  const pose = status?.sim?.pose ?? START;
  const dose = status ? demoDose(status, run?.doseId ?? null) : null;
  const phase = status ? demoPhase(status, run?.runId ?? null, dose) : "idle";
  const running = phase === "running";

  // The clock goes back to real time when the page is left: the app's other pages share this simulator.
  useEffect(() => () => void simulator?.setSpeed(1), [simulator]);

  // How far this run has got, and where the drone has been.
  useEffect(() => {
    if (!status || !running) return;
    const step = stepOf(status.mission.state);
    if (step !== null) furthest.current = Math.max(furthest.current ?? 0, step);
    const at = status.sim?.pose;
    if (!at || onGround(at)) return;
    const last = track.current[track.current.length - 1];
    if (!last || Math.hypot(at.x_m - last.x, at.distance_m - last.distance) >= TRACK_STEP_M) {
      track.current = [...track.current.slice(-TRACK_MAX), { x: at.x_m, distance: at.distance_m }];
    }
  }, [status, running]);

  // After Stop: land a drone that is still up (logic/demo.ts landAction says when the toggle may be sent).
  const { lastServerMessage, send } = control;
  useEffect(() => {
    if (!stopping || !status || status.mission.state !== "aborted") return;
    const now = Date.now();
    const at = status.sim?.pose;
    const grounded = onGround(at);
    groundedSince.current = grounded ? (groundedSince.current ?? now) : null;
    const action = landAction({
      flying: at?.airborne === true,
      grounded,
      groundedFor: grounded ? now - groundedSince.current! : 0,
      sentAt: landSentAt.current,
      reply: landReply(lastServerMessage),
      now,
    });
    if (action === "landed") setStopping(false);
    else if (action === "send" && send({ type: "takeoff_land" })) landSentAt.current = now;
  }, [stopping, status, lastServerMessage, send]);

  const start = async () => {
    if (!status) return;
    setBusy(true);
    setProblem(null);
    setStoppedHere(false);
    setStopping(false);
    furthest.current = null;
    track.current = [];
    landSentAt.current = null;
    try {
      setRun(await startDemoRun(call, status.sim?.scenario ?? "empty", status.care.now_local, DEMO.doseLabel));
    } catch (e) {
      setRun(null);
      const blockers = blockersFrom(e);
      setProblem(blockers ? blockers.map((code) => blockerText(code)).join(" ") : errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setProblem(null);
    landSentAt.current = null;
    groundedSince.current = null;
    try {
      const answer = await call<{ state?: string }>("POST", "/api/mission/abort");
      // A run that was already landing simply finishes: the landing command has been sent, and a second
      // press of the same toggle would take off again.
      const finished = answer.state === "done";
      setStoppedHere(!finished);
      setStopping(!finished);
    } catch (e) {
      setProblem(errorText(e));
    }
  };

  const acknowledge = async () => {
    if (!run) return;
    setSending(true);
    setProblem(null);
    try {
      await call("POST", `/api/doses/${encodeURIComponent(run.doseId)}/acknowledge`);
    } catch (e) {
      setProblem(errorText(e));
    } finally {
      setSending(false);
    }
  };

  const linkOpen = control.state === "open";
  const canRun = status !== null && linkOpen && !busy && !stopping && !running && readyToRun(status);
  // No Stop once the landing command has gone out: the run is seconds from its end.
  const canStop = running && mission !== null && RUN_ACTIVE.has(mission.state) && mission.state !== "landing";
  const line = status ? demoLine(status, phase, dose, stoppedHere ? (stopping ? "landing" : "landed") : "no") : null;
  const steps = stepStates(DEMO.steps.length, phase, mission?.state ?? "idle", furthest.current);
  const arrival = dose ? arrivalLine(dose) : null;
  const drawn = onGround(pose) ? track.current : [...track.current, { x: pose.x_m, distance: pose.distance_m }];

  return (
    <div className="demo" id="demo">
      <div className="demo-bar">
        {running ? (
          <button type="button" className="btn demo-go" onClick={() => void stop()} disabled={!canStop}>
            {HERO.stop}
          </button>
        ) : (
          <button type="button" className="btn btn-primary demo-go" onClick={() => void start()} disabled={!canRun}>
            {phase === "idle" ? HERO.run : HERO.runAgain}
          </button>
        )}
        {status && <CorridorSelect status={status} runActive={running || busy || stopping} id={`${ids}corridor`} />}
        {simulator && (
          <label className="check-field">
            <input
              type="checkbox"
              checked={fast}
              onChange={(e) => {
                const want = e.target.checked;
                if (simulator.setSpeed(want ? 2 : 1)) setFast(want);
              }}
            />
            <span>{DEMO.speedLabel}</span>
          </label>
        )}
        <Link className="demo-fly" to="/pilot">
          {HERO.fly}
        </Link>
      </div>

      <p className={`demo-line state tone-${problem ? "warn" : (line?.tone ?? "info")}`} role="status">
        {(problem ?? line) && <span className="dot" aria-hidden="true" />}
        <span>{problem ?? line?.text ?? (linkOpen ? "" : DEMO.linkWait)}</span>
      </p>

      <div className="demo-grid">
        <div className="demo-main">
          <figure className="demo-camera">
            <DemoCamera />
            <figcaption>{DEMO.cameraCaption}</figcaption>
          </figure>
        </div>
        <div className="demo-side">
          <ol className="demo-steps">
            {DEMO.steps.map((step, i) => (
              <li key={step} data-state={steps[i] === "todo" ? undefined : steps[i]} aria-current={steps[i] === "now" ? "step" : undefined}>
                {step}
              </li>
            ))}
          </ol>
          <figure className="demo-plan">
            <PlanView
              x={pose.x_m}
              distance={pose.distance_m}
              heading={(pose.heading_deg * Math.PI) / 180}
              track={drawn}
              landingSpot={mission?.arrive_distance_m ?? 0.45}
              actors={status?.sim?.actors ?? []}
              className="plan"
            />
            <figcaption>{DEMO.planCaption}</figcaption>
          </figure>
        </div>
      </div>

      <div className="demo-panels">
        <section className="demo-panel" aria-labelledby={`${ids}care`}>
          <h3 id={`${ids}care`}>{DEMO.carePanel}</h3>
          {dose === null ? (
            <p className="muted">{DEMO.careIdle}</p>
          ) : dose.status === "acknowledged" ? (
            <p>Thank you. We noted that you picked up {dose.label}.</p>
          ) : (
            <>
              <p className="demo-care-dose">
                {DEMO.careLead} <strong>{dose.label}</strong>
              </p>
              <p className="small">This was due at {dose.time}.</p>
              {arrival && (
                <p className="state tone-pass">
                  <span className="dot" aria-hidden="true" />
                  <span>{arrival}.</span>
                </p>
              )}
              <button type="button" className="btn btn-primary" onClick={() => void acknowledge()} disabled={sending}>
                {DEMO.pickup}
              </button>
            </>
          )}
        </section>
        <section className="demo-panel" aria-labelledby={`${ids}caregiver`}>
          <h3 id={`${ids}caregiver`}>{DEMO.caregiverPanel}</h3>
          {dose === null ? (
            <p className="muted">{DEMO.caregiverIdle}</p>
          ) : (
            <>
              <p className="demo-dose-row">
                <span>{dose.time}</span> <strong>{dose.label}</strong>
              </p>
              <p>{doseStatusLine(dose)}</p>
              {dose.status === "acknowledged" && <p className="small">{DEMO.caregiverNote}</p>}
            </>
          )}
        </section>
      </div>

      <p className="demo-honest">{DEMO.honest}</p>
    </div>
  );
}
