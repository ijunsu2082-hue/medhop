import { useCallback, useEffect, useRef, useState } from "react";
import { useControlSocket } from "../hooks/useControlSocket";
import { useFlightKeyboard } from "../hooks/useFlightKeyboard";
import { useHoldGuard } from "../hooks/useHoldGuard";
import { useStatus } from "../hooks/useStatus";
import { VideoFeed } from "../components/VideoFeed";
import { CommandBar } from "../components/pilot/CommandBar";
import { EstopBanner } from "../components/pilot/EstopBanner";
import { AxisIndicators, KeyLegend, StickPad } from "../components/pilot/ManualControls";
import { Checklist } from "../components/pilot/Checklist";
import { RunSteps } from "../components/pilot/RunSteps";
import { AdvancedPanel } from "../components/pilot/AdvancedPanel";
import { IconChevron, IconSign } from "../components/pilot/PilotIcons";
import { releaseOnLinkChange } from "../control/release";
import { missionStateText } from "../text/wording";
import "./pilot.css";
import {
  ACK_NOTE_MS,
  ESTOP_CONFIRM_MS,
  droneLinkView,
  estopBanner,
  routeReply,
  takeoffBlockedReason,
  type PendingCommand,
} from "../logic/pilot";

const RUN_OR_HOVER = new Set(["searching", "approaching", "arrived", "landing", "hover_test"]);
const NOT_CONNECTED = "Backend not reachable: controls are not connected.";

export function PilotPage() {
  const { status: rawStatus, reachable } = useStatus();
  // Never show stale numbers as live: with the backend down, the instrument panel shows nothing.
  const status = reachable === false ? null : rawStatus;
  const control = useControlSocket();
  const controlOpen = control.state === "open";

  // sentAt null: pressed while the control link was down, nothing went out.
  const [estopPending, setEstopPending] = useState<{ sentAt: number | null } | null>(null);
  const [estopAck, setEstopAck] = useState<{ at: number; delivered?: boolean } | null>(null);
  const [, setClock] = useState(0);
  const [takeoffNote, setTakeoffNote] = useState<{ ok: boolean | null; text: string } | null>(null);
  const [calNote, setCalNote] = useState<{ ok: boolean | null; text: string } | null>(null);
  // Presentation only: moves the highlighted run step from 1 to 2 once the backend acknowledged a toggle.
  const [takeoffAcked, setTakeoffAcked] = useState(false);
  const [padOpen, setPadOpen] = useState(false);
  // Send time of each command still waiting for an ack/error; cleared once its reply is consumed.
  const awaiting = useRef<Record<PendingCommand, number | null>>({ takeoff_land: null, calibrate: null });

  const estopActive = status?.pilot.estop_active ?? false;

  useEffect(() => {
    document.title = "Pilot - MedHop";
  }, []);

  // Once the backend confirms, its flag drives the banner.
  useEffect(() => {
    if (estopActive && estopPending) setEstopPending(null);
  }, [estopActive, estopPending]);

  // Re-check the banner when the 500 ms confirmation deadline passes.
  useEffect(() => {
    if (!estopPending || estopPending.sentAt === null) return;
    const left = estopPending.sentAt + ESTOP_CONFIRM_MS - Date.now();
    const t = setTimeout(() => setClock((n) => n + 1), Math.max(0, left) + 20);
    return () => clearTimeout(t);
  }, [estopPending]);

  const takeoffFire = useCallback(() => {
    const at = Date.now();
    const sent = control.send({ type: "takeoff_land" });
    if (sent) {
      awaiting.current.takeoff_land = at;
      setTakeoffNote({ ok: null, text: "Toggle sent. Waiting for the backend to acknowledge." });
    } else {
      awaiting.current.takeoff_land = null;
      setTakeoffNote({ ok: false, text: "Not sent: control link is not connected." });
    }
  }, [control]);

  const hold = useHoldGuard(takeoffFire);

  const calibrateFire = useCallback(() => {
    const at = Date.now();
    const sent = control.send({ type: "calibrate" });
    if (sent) {
      awaiting.current.calibrate = at;
      setCalNote({ ok: null, text: "Calibrate sent. Waiting for the backend to acknowledge." });
    } else {
      awaiting.current.calibrate = null;
      setCalNote({ ok: false, text: "Not sent: control link is not connected." });
    }
  }, [control]);

  const calHold = useHoldGuard(calibrateFire);

  const backendDown = reachable === false;
  const takeoffBlocked = takeoffBlockedReason({
    backendReachable: !backendDown,
    controlOpen,
    missionState: status?.mission.state ?? null,
    estopActive,
  });
  const takeoffBlockedRef = useRef(takeoffBlocked);
  takeoffBlockedRef.current = takeoffBlocked;

  const { flight, axes, keysPaused } = useFlightKeyboard({
    send: control.send,
    onEstop: () => doEstop(),
    // T does nothing while takeoff/land is unavailable; the reason is shown next to the button.
    onTakeoffHoldStart: () => {
      if (takeoffBlockedRef.current === null) hold.start();
    },
    onTakeoffHoldCancel: hold.cancel,
  });

  // When the control link leaves "open", nothing may stay held across the reconnect (SPEC 10.5).
  const holdCancel = hold.cancel;
  const calHoldCancel = calHold.cancel;
  useEffect(() => {
    releaseOnLinkChange(controlOpen, flight, [{ cancel: holdCancel }, { cancel: calHoldCancel }]);
  }, [controlOpen, flight, holdCancel, calHoldCancel]);

  // Release a takeoff hold in progress if the button becomes unavailable mid-hold (e.g. landing starts).
  useEffect(() => {
    if (takeoffBlocked !== null) holdCancel();
  }, [takeoffBlocked, holdCancel]);

  const doEstop = () => {
    const at = Date.now();
    const sent = control.send({ type: "estop" });
    setEstopPending({ sentAt: sent ? at : null });
    hold.cancel();
    calHold.cancel();
    flight.releaseAll();
  };

  const resetEstop = () => {
    control.send({ type: "estop_reset" });
    setEstopPending(null);
  };

  // Show server acks / errors from the control socket, matched to the command they answer by `of` and time.
  const last = control.lastServerMessage;
  useEffect(() => {
    if (!last) return;
    if (last.msg.type === "ack" && last.msg.of === "estop") {
      setEstopAck({ at: last.at, delivered: last.msg.delivered });
      return;
    }
    const routed = routeReply(last, awaiting.current);
    if (!routed) return;
    awaiting.current[routed.of] = null;
    const note = { ok: routed.ok, text: routed.text };
    if (routed.of === "calibrate") setCalNote(note);
    else {
      setTakeoffNote(note);
      if (routed.ok) setTakeoffAcked(true);
    }
  }, [last]);

  // The "sent to the drone" notes expire after a few seconds; errors stay until the next command.
  useEffect(() => {
    if (takeoffNote?.ok !== true) return;
    const t = setTimeout(() => setTakeoffNote((n) => (n === takeoffNote ? null : n)), ACK_NOTE_MS);
    return () => clearTimeout(t);
  }, [takeoffNote]);
  useEffect(() => {
    if (calNote?.ok !== true) return;
    const t = setTimeout(() => setCalNote((n) => (n === calNote ? null : n)), ACK_NOTE_MS);
    return () => clearTimeout(t);
  }, [calNote]);

  const estopView = estopBanner({
    reachable,
    // While the backend is unreachable this is the last known value (status itself is hidden then).
    estopActive: rawStatus ? rawStatus.pilot.estop_active : null,
    estopDelivered: rawStatus?.pilot.estop_delivered,
    pending: estopPending,
    ack: estopAck,
    now: Date.now(),
  });
  const droneLink = droneLinkView(status);

  const waiting = (text: string) =>
    backendDown ? (
      <p className="msg msg-fail" role="status">
        {NOT_CONNECTED}
      </p>
    ) : (
      <p className="muted">{text}</p>
    );

  const runOrHover = status ? RUN_OR_HOVER.has(status.mission.state) || (status.hover_test?.running ?? false) : false;
  const calBlocked = backendDown
    ? NOT_CONNECTED
    : !status
      ? "Waiting for status."
      : !controlOpen
        ? "Not available: control link is not connected."
        : runOrHover
          ? "Not available while a station run or hover test is active."
          : null;

  // Release a hold in progress if the button becomes unavailable mid-hold.
  const calCancel = calHold.cancel;
  useEffect(() => {
    if (calBlocked !== null) calCancel();
  }, [calBlocked, calCancel]);

  return (
    <div className="pilot">
      {/* The stop button and the emergency-stop banner stay together at the top while scrolling. */}
      <div className="pilot-sticky">
        <CommandBar
          mode={status?.mode ?? null}
          control={control.state}
          backendReachable={!backendDown}
          onEstop={doEstop}
          takeoff={hold}
          takeoffBlocked={takeoffBlocked}
          takeoffNote={takeoffNote}
          droneLink={droneLink}
        />
        <EstopBanner
          view={estopView}
          controlOpen={controlOpen}
          onReset={resetEstop}
          onRetry={doEstop}
          onDismiss={() => setEstopPending(null)}
        />
      </div>
      {control.state === "refused" && (
        <div className="banner banner-fail pilot-refused" role="alert">
          Another pilot window is connected. This window cannot fly the drone. Close the other window; this one retries every 5 s.
        </div>
      )}

      <header className="pilot-intro">
        <h1>Pilot: fly the drone to the station</h1>
        <p className="pilot-lede">
          Fly a small toy drone from this laptop. A station run turns the drone until its camera sees the printed station
          sign, flies toward it and stops. The Care page then shows that it arrived at the station.
        </p>
        {status?.mode === "sim" && (
          <p className="pilot-sim-note">
            <span className="chip">Simulator</span>
            <span>No real drone moves.</span>
          </p>
        )}
      </header>

      <div className="pilot-grid">
        <section className="panel pilot-run" aria-labelledby="h-run">
          {status ? (
            <RunSteps
              status={status}
              controlOpen={controlOpen}
              hold={hold}
              takeoffBlocked={takeoffBlocked}
              takeoffNote={takeoffNote}
              takeoffAcked={takeoffAcked}
              onResetEstop={resetEstop}
            />
          ) : (
            <>
              <h2 id="h-run">Station run</h2>
              {waiting("Waiting for status.")}
            </>
          )}
        </section>
        <section className="panel pilot-camera" aria-labelledby="h-video">
          <div className="pilot-camera-head">
            <h2 id="h-video">Camera</h2>
          </div>
          <VideoFeed
            videoLive={status ? status.link.video_live : null}
            backendReachable={reachable !== false}
            chips={
              status ? (
                <>
                  <span className={`vchip ${status.mode === "sim" ? "vchip-sim" : "vchip-real"}`}>
                    {status.mode === "sim" ? "Simulator" : "Real drone"}
                  </span>
                  <span className={`vchip vchip-state vchip-state-${status.mission.state}`}>
                    {missionStateText(status.mission.state)}
                  </span>
                  <span className={`vchip ${status.vision.marker ? "vchip-pass" : "vchip-muted"}`}>
                    <IconSign size={14} />
                    {status.vision.marker ? "Station sign in view" : "Station sign not in view"}
                  </span>
                  {status.pilot.estop_active && <span className="vchip vchip-fail">Emergency stop active</span>}
                </>
              ) : (
                <span className="vchip vchip-muted">Waiting for status</span>
              )
            }
          />
          <p className="hint small pilot-caption">
            640x360 stream from the drone, shown enlarged. The station sign is detected with ArUco (classical computer
            vision). Person boxes are an advisory check only.
          </p>
          <section className="pilot-check" aria-labelledby="h-check">
            <h2 id="h-check" className="eyebrow">
              Pre-flight checklist
            </h2>
            {status ? <Checklist status={status} /> : waiting("Waiting for status from the backend.")}
          </section>
        </section>
      </div>

      <section className="panel pilot-manual" aria-labelledby="h-manual">
        <h2 id="h-manual">Manual flying</h2>
        <div className="manual-grid">
          <div className="manual-keys">
            <p className="eyebrow">Keyboard</p>
            <KeyLegend />
            <p className="hint small">
              Keys work anywhere on this page, including while a slider, checkbox, list or button is selected. They are
              ignored while you type in a text field.
            </p>
          </div>
          <div className="manual-live">
            <p className="eyebrow">Live input</p>
            {keysPaused && (
              <p className="msg msg-warn" role="status">
                Keys paused while you type in a text field: flight keys, T and Space (emergency stop) do nothing here.
                Click an empty part of the page to use them again.
              </p>
            )}
            {!controlOpen && (
              <p className="msg msg-warn" role="status">
                Control link not connected: stick input is not being sent.
              </p>
            )}
            <AxisIndicators axes={axes} maxStick={status?.pilot.max_stick ?? null} />
            {status && (
              <p className="small manual-note">
                Manual input reaching the backend: <span className="manual-note-value">{status.pilot.manual_active ? "yes" : "no"}</span>
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          className="disclosure"
          aria-expanded={padOpen}
          aria-controls="stickpad-body"
          onClick={(e) => {
            setPadOpen((o) => !o);
            // Give focus back so Space and the flight keys never land on this button (SPEC 10.5).
            e.currentTarget.blur();
          }}
        >
          <IconChevron className="disclosure-chevron" />
          On-screen sticks
        </button>
        <div id="stickpad-body" hidden={!padOpen}>
          <StickPad flight={flight} disabled={!controlOpen} />
        </div>
      </section>

      <AdvancedPanel
        status={status}
        waiting={waiting("Waiting for status.")}
        send={control.send}
        controlOpen={controlOpen}
        calHold={calHold}
        calBlocked={calBlocked}
        calNote={calNote}
      />
    </div>
  );
}
