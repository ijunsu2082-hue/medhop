import { describe, expect, it } from "vitest";
import type { MissionStatus, Status } from "../api/types";
import {
  ACK_TEXT,
  AUTO_BACKEND_REFUSES,
  AUTO_CONTROL_LINK_BLOCKER,
  AUTO_STAGES,
  ESTOP_CONFIRM_MS,
  NEEDS_PILOT_TEXT,
  RUN_ACTIVE_STATES,
  alignmentLine,
  autoBlockerTexts,
  autoDistanceLine,
  autoReadyView,
  autoResultView,
  autoStageIndex,
  autoSupported,
  countdownText,
  doneMessage,
  formatMetres,
  landingExplainerText,
  lateralText,
  parseRunMode,
  droneLinkView,
  estopBanner,
  routeReply,
  takeoffBlockedReason,
  type EstopInput,
} from "./pilot";

const T0 = 1_000_000;

function estop(over: Partial<EstopInput>): EstopInput {
  return {
    reachable: true,
    estopActive: false,
    estopDelivered: undefined,
    pending: null,
    ack: null,
    now: T0,
    ...over,
  };
}

function allText(v: ReturnType<typeof estopBanner>): string {
  return v ? `${v.headline} ${v.detail}` : "";
}

describe("estopBanner (SPEC 10.5)", () => {
  it("no banner when nothing is pressed and the stop is not latched", () => {
    expect(estopBanner(estop({}))).toBeNull();
    expect(estopBanner(estop({ estopActive: null, reachable: null }))).toBeNull();
  });

  it("unsent: pressed while the control link was down, with retry, dismiss and switch-off advice", () => {
    const v = estopBanner(estop({ pending: { sentAt: null } }))!;
    expect(v.kind).toBe("unsent");
    expect(v.headline).toMatch(/NOT sent/);
    expect(v.detail).toMatch(/switch it off by hand when safe/);
    expect(v).toMatchObject({ retry: true, dismiss: true, reset: false });
  });

  it("sent: on the socket, under 500 ms, no answer yet: 'SENT, not confirmed'", () => {
    const v = estopBanner(estop({ pending: { sentAt: T0 }, now: T0 + ESTOP_CONFIRM_MS - 1 }))!;
    expect(v.kind).toBe("sent");
    expect(v.headline).toBe("Emergency stop SENT, not confirmed");
    expect(v.retry).toBe(false);
  });

  it("not_confirmed: no ack and no estop_active within 500 ms: failed variant with retry and advice", () => {
    const v = estopBanner(estop({ pending: { sentAt: T0 }, now: T0 + ESTOP_CONFIRM_MS }))!;
    expect(v.kind).toBe("not_confirmed");
    expect(v.headline).toMatch(/NOT confirmed/);
    expect(v.detail).toMatch(/switch it off by hand when safe/);
    expect(v.retry).toBe(true);
  });

  it("unknown: status unreachable with a press pending or the stop last seen latched", () => {
    for (const over of [
      { reachable: false, pending: { sentAt: T0 }, now: T0 + 10 },
      { reachable: false, estopActive: true },
      { reachable: false, estopActive: true, estopDelivered: true },
    ] as Partial<EstopInput>[]) {
      const v = estopBanner(estop(over))!;
      expect(v.kind).toBe("unknown");
      expect(v.headline).toMatch(/state unknown/);
      expect(v.detail).toMatch(/switch it off by hand when safe/);
      expect(v.retry).toBe(true);
    }
    // Unreachable but nothing pressed and not latched: the backend-down banner elsewhere is enough.
    expect(estopBanner(estop({ reachable: false }))).toBeNull();
  });

  it("active_sending: latched and estop_delivered true", () => {
    const v = estopBanner(estop({ estopActive: true, estopDelivered: true }))!;
    expect(v.kind).toBe("active_sending");
    expect(v.detail).toMatch(/Motor-cut command is being sent to the drone/);
    expect(v.reset).toBe(true);
  });

  it("active_not_delivered: latched but not delivered (drone link reconnecting)", () => {
    const v = estopBanner(estop({ estopActive: true, estopDelivered: false }))!;
    expect(v.kind).toBe("active_not_delivered");
    expect(allText(v)).toBe(
      "Emergency stop NOT delivered yet: drone link reconnecting. If the drone is still flying, keep clear and switch it off by hand when safe.",
    );
  });

  it("active_legacy: older backend without estop_delivered", () => {
    const v = estopBanner(estop({ estopActive: true, estopDelivered: undefined }))!;
    expect(v.kind).toBe("active_legacy");
    expect(v.headline).toBe("Emergency stop active: motor-cut command sent.");
  });

  it("an estop ack after the press confirms it before status catches up, and carries `delivered`", () => {
    const base = { pending: { sentAt: T0 }, now: T0 + 2000 };
    expect(estopBanner(estop({ ...base, ack: { at: T0 + 30, delivered: true } }))!.kind).toBe("active_sending");
    expect(estopBanner(estop({ ...base, ack: { at: T0 + 30, delivered: false } }))!.kind).toBe("active_not_delivered");
    expect(estopBanner(estop({ ...base, ack: { at: T0 + 30 } }))!.kind).toBe("active_legacy");
    // An ack from before this press does not confirm it.
    expect(estopBanner(estop({ ...base, ack: { at: T0 - 1, delivered: true } }))!.kind).toBe("not_confirmed");
    // Status, once latched, is the newer word on delivery.
    expect(estopBanner(estop({ ...base, estopActive: true, estopDelivered: false, ack: { at: T0 + 30, delivered: true } }))!.kind).toBe(
      "active_not_delivered",
    );
  });

  it("never says 'Motors are cut' in any state", () => {
    const inputs: Partial<EstopInput>[] = [
      { pending: { sentAt: null } },
      { pending: { sentAt: T0 } },
      { pending: { sentAt: T0 }, now: T0 + 5000 },
      { reachable: false, estopActive: true },
      { estopActive: true, estopDelivered: true },
      { estopActive: true, estopDelivered: false },
      { estopActive: true },
    ];
    for (const i of inputs) {
      const t = allText(estopBanner(estop(i))).toLowerCase();
      expect(t.length).toBeGreaterThan(0);
      expect(t).not.toContain("motors are cut");
      expect(t).not.toContain("delivered.");
      expect(t).not.toMatch(/—/);
    }
  });
});

describe("takeoff/land availability", () => {
  it("disabled while landing, with the note 'Landing in progress'", () => {
    expect(takeoffBlockedReason({ backendReachable: true, controlOpen: true, missionState: "landing" })).toBe("Landing in progress");
    expect(takeoffBlockedReason({ backendReachable: true, controlOpen: true, missionState: "approaching" })).toBeNull();
    expect(takeoffBlockedReason({ backendReachable: true, controlOpen: true, missionState: null })).toBeNull();
    expect(takeoffBlockedReason({ backendReachable: true, controlOpen: false, missionState: "idle" })).toMatch(/control link/);
    expect(takeoffBlockedReason({ backendReachable: false, controlOpen: true, missionState: "idle" })).toMatch(/backend not reachable/);
    expect(takeoffBlockedReason({ backendReachable: true, controlOpen: true, missionState: "idle", estopActive: true })).toMatch(
      /Emergency stop is on/,
    );
    expect(takeoffBlockedReason({ backendReachable: true, controlOpen: true, missionState: "idle", estopActive: false })).toBeNull();
  });
});

describe("routeReply: matching acks/errors to commands by `of` and time", () => {
  const none = { takeoff_land: null, calibrate: null };

  it("an ack for a waiting command says 'sent to the drone (the drone does not confirm)'", () => {
    const r = routeReply({ msg: { type: "ack", of: "takeoff_land" }, at: T0 + 10 }, { ...none, takeoff_land: T0 });
    expect(r).toEqual({ of: "takeoff_land", ok: true, text: ACK_TEXT.takeoff_land });
    expect(r!.text).toContain("sent to the drone (the drone does not confirm)");
    expect(routeReply({ msg: { type: "ack", of: "calibrate" }, at: T0 }, { ...none, calibrate: T0 })!.of).toBe("calibrate");
  });

  it("ignores a reply older than the command, a reply for a command not waiting, and unrelated acks", () => {
    expect(routeReply({ msg: { type: "error", of: "takeoff_land", message: "old" }, at: T0 - 1 }, { ...none, takeoff_land: T0 })).toBeNull();
    expect(routeReply({ msg: { type: "ack", of: "takeoff_land" }, at: T0 }, none)).toBeNull();
    expect(routeReply({ msg: { type: "ack", of: "estop" }, at: T0 }, { takeoff_land: T0, calibrate: T0 })).toBeNull();
    expect(routeReply({ msg: { type: "error", of: "estop", message: "x" }, at: T0 }, { takeoff_land: T0, calibrate: T0 })).toBeNull();
    expect(routeReply(null, { ...none, takeoff_land: T0 })).toBeNull();
  });

  it("an error goes to the command named in `of`, with plain-English text for each code", () => {
    const waiting = { takeoff_land: T0, calibrate: T0 + 5 };
    const cases: [string, RegExp][] = [
      ["landing_in_progress", /landing command/],
      ["drone_link_down", /drone link is down/],
      ["estop_active", /emergency stop is active/],
      ["toggle_guard", /Wait a few seconds/],
    ];
    for (const [code, re] of cases) {
      const r = routeReply({ msg: { type: "error", of: "takeoff_land", code, message: "raw" }, at: T0 + 10 }, waiting)!;
      expect(r.of).toBe("takeoff_land");
      expect(r.ok).toBe(false);
      expect(r.text).toMatch(re);
      expect(r.text).not.toContain(code);
    }
  });

  it("an error without `of` (older backend) goes to the most recently sent waiting command; unknown code shows the message", () => {
    const r = routeReply({ msg: { type: "error", message: "busy" }, at: T0 + 10 }, { takeoff_land: T0, calibrate: T0 + 5 })!;
    expect(r).toEqual({ of: "calibrate", ok: false, text: "Backend: busy" });
    expect(routeReply({ msg: { type: "error", message: "busy" }, at: T0 + 10 }, { takeoff_land: T0, calibrate: null })!.of).toBe(
      "takeoff_land",
    );
    expect(routeReply({ msg: { type: "error", message: "busy" }, at: T0 }, none)).toBeNull();
  });
});

describe("droneLinkView (drone link apart from the browser control link)", () => {
  const s = (mode: Status["mode"], link: Partial<Status["link"]>): Pick<Status, "mode" | "link"> => ({
    mode,
    link: { video_live: true, frame_age_s: 0.1, fps: 15, ...link },
  });

  it("real mode: connected / reconnecting / no reply yet", () => {
    expect(droneLinkView(s("real", { control_up: true, drone_seen: true })).link).toEqual({ tone: "pass", text: "Drone link: connected" });
    expect(droneLinkView(s("real", { control_up: false, drone_seen: true })).link!.text).toBe(
      "Drone link: reconnecting. Commands are not reaching the drone.",
    );
    expect(droneLinkView(s("real", { control_up: true, drone_seen: false })).link!.text).toBe(
      "No reply from the drone yet. Is this laptop on the drone's Wi-Fi?",
    );
  });

  it("sticks_blocked adds the stale-video line", () => {
    const v = droneLinkView(s("real", { control_up: true, drone_seen: true, sticks_blocked: true }));
    expect(v.sticks).toBe("Video is stale: sticks are held neutral until it returns. Emergency stop and takeoff/land still work.");
    expect(droneLinkView(s("real", { control_up: true, drone_seen: true, sticks_blocked: false })).sticks).toBeNull();
  });

  it("sim mode says simulator", () => {
    expect(droneLinkView(s("sim", { control_up: true, drone_seen: true })).link!.text).toBe("Simulator (no real drone)");
    expect(droneLinkView(s("sim", {})).link!.text).toBe("Simulator (no real drone)");
  });

  it("an older backend without the fields shows nothing alarming (no line at all)", () => {
    expect(droneLinkView(s("real", {}))).toEqual({ link: null, sticks: null });
    expect(droneLinkView(null)).toEqual({ link: null, sticks: null });
  });
});

describe("end-of-run message from mission.last_landing (SPEC 10.2)", () => {
  it("sent", () => {
    expect(doneMessage("sent")).toBe(
      "Arrived at station. The landing command was sent once: check that the drone has landed.",
    );
  });

  it("skipped_settle_guard_undecided", () => {
    expect(doneMessage("skipped_settle_guard_undecided")).toBe(
      "Arrived at station. The landing command was NOT sent (the descent check could not decide). Land by hand.",
    );
  });

  it("refused_by_mixer", () => {
    expect(doneMessage("refused_by_mixer")).toBe(
      "Arrived at station. The landing command was NOT sent (the safety layer refused it, for example because you used the controls just before or the drone link was down). Land by hand.",
    );
  });

  it("off", () => {
    expect(doneMessage("off")).toBe("Arrived at station. Landing on arrival is off: land by hand.");
  });

  it("null, missing (older backend) or an unknown value asks the pilot to check", () => {
    const unknown = "Arrived at station. Check whether the drone has landed; land by hand if not.";
    expect(doneMessage(null)).toBe(unknown);
    expect(doneMessage(undefined)).toBe(unknown);
    expect(doneMessage("something_new")).toBe(unknown);
  });
});

// ---------------------------------------------------------------- automatic station run

function mission(over: Partial<MissionStatus> = {}): MissionStatus {
  return {
    state: "idle",
    reason: null,
    run_id: null,
    dose_id: null,
    elapsed_s: 0,
    command: { yaw: 0, pitch: 0 },
    arrive_width: 0.16,
    land_on_arrival: true,
    can_start: true,
    blockers: [],
    automatic: false,
    auto_fly: false,
    auto_blockers: [],
    can_start_auto: true,
    distance_m: null,
    arrive_distance_m: 0.8,
    flight_confirmed: false,
    ...over,
  };
}

describe("automatic run: stages", () => {
  it("has the six stages in order", () => {
    expect([...AUTO_STAGES]).toEqual(["Take off", "Find the sign", "Fly to the sign", "Line up", "Land", "At the station"]);
  });
  it("maps mission states to a stage", () => {
    expect(autoStageIndex("countdown")).toBe(0);
    expect(autoStageIndex("taking_off")).toBe(0);
    expect(autoStageIndex("searching")).toBe(1);
    expect(autoStageIndex("approaching")).toBe(2);
    expect(autoStageIndex("aligning")).toBe(3);
    expect(autoStageIndex("arrived")).toBe(4);
    expect(autoStageIndex("landing")).toBe(4);
    expect(autoStageIndex("done")).toBe(5);
    for (const s of ["idle", "aborted", "hover_test", "brand_new"]) expect(autoStageIndex(s)).toBe(-1);
  });
  it("counts down in whole seconds, rounded up, only during the countdown", () => {
    expect(countdownText("countdown", 4.2)).toBe("Taking off in 5");
    expect(countdownText("countdown", 1)).toBe("Taking off in 1");
    expect(countdownText("countdown", 0.01)).toBe("Taking off in 1");
    expect(countdownText("countdown", -0.3)).toBe("Taking off in 0");
    expect(countdownText("countdown", null)).toBe("Taking off in a few seconds");
    expect(countdownText("countdown", undefined)).toBe("Taking off in a few seconds");
    expect(countdownText("taking_off", 3)).toBeNull();
  });
});

describe("aligning: live line", () => {
  it("counts aligning as a run in progress", () => {
    expect(RUN_ACTIVE_STATES.has("aligning")).toBe(true);
  });
  it("reads the full line", () => {
    expect(alignmentLine({ lateral_m: -0.04, distance_m: 0.81, target_distance_m: 0.8, tolerance_m: 0.05, aligned_for_s: 0.6, need_s: 1.0 })).toBe(
      "4 cm left of the centre line, 0.81 m from the sign. Holding still 0.6 of 1.0 s.",
    );
    expect(alignmentLine({ lateral_m: 0.123, distance_m: 0.8, aligned_for_s: 0, need_s: 1 })).toBe(
      "12 cm right of the centre line, 0.80 m from the sign. Holding still 0.0 of 1.0 s.",
    );
  });
  it("says on the centre line under 0.5 cm, either side", () => {
    expect(lateralText(0.004)).toBe("on the centre line");
    expect(lateralText(-0.0049)).toBe("on the centre line");
    expect(lateralText(0)).toBe("on the centre line");
    expect(lateralText(0.006)).toBe("1 cm right of the centre line");
    expect(lateralText(-0.006)).toBe("1 cm left of the centre line");
    expect(alignmentLine({ lateral_m: 0.002, distance_m: 0.79 })).toBe("On the centre line, 0.79 m from the sign.");
  });
  it("leaves out parts that are missing", () => {
    expect(alignmentLine({ lateral_m: null, distance_m: 0.81, aligned_for_s: 0.6, need_s: 1 })).toBe("0.81 m from the sign. Holding still 0.6 of 1.0 s.");
    expect(alignmentLine({ lateral_m: 0.05, distance_m: null })).toBe("5 cm right of the centre line.");
    expect(alignmentLine({ lateral_m: null, distance_m: null, aligned_for_s: 0.3, need_s: 1 })).toBe("Holding still 0.3 of 1.0 s.");
    expect(alignmentLine({ aligned_for_s: 0.3 })).toBeNull();
    expect(alignmentLine({ lateral_m: Number.NaN, distance_m: -1 })).toBeNull();
    expect(alignmentLine({})).toBeNull();
    expect(alignmentLine(null)).toBeNull();
    expect(alignmentLine(undefined)).toBeNull();
  });
});

describe("automatic run: distance line", () => {
  it("rounds to 0.1 m", () => {
    expect(formatMetres(1.94)).toBe("1.9");
    expect(formatMetres(0.75)).toBe("0.8");
    expect(formatMetres(null)).toBeNull();
    expect(formatMetres(Number.NaN)).toBeNull();
    expect(formatMetres(-1)).toBeNull();
  });
  it("shows the distance and the landing distance", () => {
    expect(autoDistanceLine(1.92, 0.8)).toBe("Sign about 1.9 m away. It lands at about 0.8 m.");
  });
  it("leaves out the first half while the sign is not in view", () => {
    expect(autoDistanceLine(null, 0.8)).toBe("It lands at about 0.8 m.");
  });
  it("shows nothing from an older backend", () => {
    expect(autoDistanceLine(undefined, undefined)).toBeNull();
  });
});

describe("automatic run: blockers", () => {
  it("an older backend without the automatic fields is not supported", () => {
    const old = mission();
    delete old.auto_blockers;
    delete old.can_start_auto;
    expect(autoSupported(old)).toBe(false);
    expect(autoSupported(mission())).toBe(true);
  });
  it("maps blocker codes to sentences, including drone_flying and recent_toggle", () => {
    expect(autoBlockerTexts(mission({ auto_blockers: ["drone_flying"], can_start_auto: false }), true)).toEqual([
      "The drone is already in the air. Land it first, or use Step by step.",
    ]);
    expect(autoBlockerTexts(mission({ auto_blockers: ["recent_toggle"], can_start_auto: false }), true)).toEqual([
      "Takeoff or landing was pressed a moment ago. Wait a few seconds.",
    ]);
    expect(autoBlockerTexts(mission({ auto_blockers: ["no_video"], can_start_auto: false }), true)).toEqual([
      "There is no live video from the drone.",
    ]);
  });
  it("never needs the airborne confirmation", () => {
    expect(autoBlockerTexts(mission({ blockers: ["confirm_airborne_required"] }), true)).toEqual([]);
  });
  it("adds the control link and a generic line when the backend refuses without a reason", () => {
    expect(autoBlockerTexts(mission({ can_start_auto: false }), false)).toEqual([
      AUTO_BACKEND_REFUSES,
      AUTO_CONTROL_LINK_BLOCKER,
    ]);
  });
  it("shows no blockers while a run is in progress", () => {
    expect(autoBlockerTexts(mission({ state: "searching", auto_blockers: ["already_running"], can_start_auto: false }), true)).toEqual([]);
  });
});

describe("automatic run: result card", () => {
  it("only for an automatic run that ended", () => {
    expect(autoResultView(mission({ state: "done", automatic: false, last_landing: "sent" }))).toBeNull();
    expect(autoResultView(mission({ state: "done", automatic: undefined, last_landing: "sent" }))).toBeNull();
    expect(autoResultView(mission({ state: "searching", automatic: true }))).toBeNull();
  });
  it("done with the landing sent", () => {
    expect(autoResultView(mission({ state: "done", automatic: true, last_landing: "sent", arrive_distance_m: 0.83 }))).toEqual({
      tone: "pass",
      text: "At the station, about 0.8 m in front of the sign. The land command was sent: check that it has landed.",
    });
    expect(autoResultView(mission({ state: "done", automatic: true, last_landing: "sent", arrive_distance_m: undefined }))).toEqual({
      tone: "pass",
      text: "At the station, in front of the sign. The land command was sent: check that it has landed.",
    });
  });
  it("done with the landing sent and where it arrived", () => {
    const done = { state: "done" as const, automatic: true, last_landing: "sent" as const, arrive_distance_m: 0.8 };
    expect(autoResultView(mission({ ...done, last_arrival: { lateral_offset_m: -0.03, distance_m: 0.82, aligned: true } }))).toEqual({
      tone: "pass",
      text: "At the station: about 0.82 m from the sign, 3 cm left of the centre line. The land command was sent: check that it has landed.",
    });
    expect(autoResultView(mission({ ...done, last_arrival: { lateral_offset_m: 0.09, distance_m: 0.8, aligned: false } }))?.text).toBe(
      "At the station: about 0.80 m from the sign, 9 cm right of the centre line. The land command was sent: check that it has landed. It could not line up exactly.",
    );
    expect(autoResultView(mission({ ...done, last_arrival: { lateral_offset_m: null, distance_m: 0.8, aligned: true } }))?.text).toBe(
      "At the station: about 0.80 m from the sign. The land command was sent: check that it has landed.",
    );
    expect(autoResultView(mission({ ...done, last_arrival: { lateral_offset_m: null, distance_m: null, aligned: false } }))?.text).toBe(
      "At the station. The land command was sent: check that it has landed. It could not line up exactly.",
    );
    expect(autoResultView(mission({ ...done, last_arrival: null }))?.text).toBe(
      "At the station, about 0.8 m in front of the sign. The land command was sent: check that it has landed.",
    );
  });
  it("done without the landing sent falls back to the land-by-hand message", () => {
    expect(autoResultView(mission({ state: "done", automatic: true, last_landing: "refused_by_mixer" }))).toEqual({
      tone: "warn",
      text: doneMessage("refused_by_mixer"),
    });
  });
  it("stopped early with a safe landing", () => {
    expect(autoResultView(mission({ state: "aborted", automatic: true, reason: "marker_lost", last_landing: "safe_landing" }))).toEqual({
      tone: "warn",
      text: "Stopped early: the station sign was lost from view during the approach and could not be found again. The land command was sent where it was: check that it has landed.",
    });
  });
  it("a safe landing drops the reason's land-by-hand advice", () => {
    const text = autoResultView(mission({ state: "aborted", automatic: true, reason: "pilot_link_lost", last_landing: "safe_landing" }))?.text ?? "";
    expect(text.startsWith("Stopped early: ")).toBe(true);
    expect(text).not.toMatch(/land by hand/i);
    expect(text).toMatch(/The land command was sent where it was/);
  });
  it("stopped early without a landing", () => {
    expect(autoResultView(mission({ state: "aborted", automatic: true, reason: "takeoff_refused", last_landing: null }))?.text).toBe(
      "Stopped early: the takeoff command was not accepted. If it is still in the air, land it with T or the emergency stop.",
    );
    expect(autoResultView(mission({ state: "aborted", automatic: true, reason: "not_lined_up" }))?.text).toBe(
      "Stopped early: it got close to the sign but could not line up in front of it. If it is still in the air, land it with T or the emergency stop.",
    );
    expect(autoResultView(mission({ state: "aborted", automatic: true, reason: "already_at_station" }))?.text).toBe(
      "Stopped early: it was already at the sign after takeoff. Put it back on its start spot. If it is still in the air, land it with T or the emergency stop.",
    );
    expect(autoResultView(mission({ state: "aborted", automatic: true, reason: "brand_new" }))?.text).toContain("(code: brand_new)");
  });
});

describe("automatic run: ready for the next dose", () => {
  it("only while automatic flights are on and the backend reports readiness", () => {
    expect(autoReadyView(mission({ auto_fly: false, ready_for_dose: false }))).toBeNull();
    expect(autoReadyView(mission({ auto_fly: true }))).toBeNull();
    expect(autoReadyView(mission({ auto_fly: true, ready_for_dose: false }))).toEqual({
      ready: false,
      text: "Before the next dose: put the drone on its start spot facing the sign, then press",
    });
    expect(autoReadyView(mission({ auto_fly: true, ready_for_dose: true }))).toEqual({
      ready: true,
      text: "Ready. It will take off by itself when the next dose is due.",
    });
  });
});

describe("automatic run: wording", () => {
  it("uses the backend's landing distance in the explainer", () => {
    expect(landingExplainerText(0.94)).toContain("about 0.9 m in front of the sign");
    expect(landingExplainerText(undefined)).toContain("about 0.8 m in front of the sign");
  });
  it("remembers the run mode, Automatic by default", () => {
    expect(parseRunMode("steps")).toBe("steps");
    expect(parseRunMode("auto")).toBe("auto");
    expect(parseRunMode(null)).toBe("auto");
    expect(parseRunMode("garbage")).toBe("auto");
  });
  it("never says delivered, never claims motors are cut, no em or en dashes", () => {
    const all = [
      ...AUTO_STAGES,
      NEEDS_PILOT_TEXT,
      AUTO_BACKEND_REFUSES,
      AUTO_CONTROL_LINK_BLOCKER,
      landingExplainerText(0.8),
      autoDistanceLine(1.9, 0.8) ?? "",
      autoReadyView(mission({ auto_fly: true, ready_for_dose: true }))?.text ?? "",
      autoReadyView(mission({ auto_fly: true, ready_for_dose: false }))?.text ?? "",
      autoResultView(mission({ state: "done", automatic: true, last_landing: "sent" }))?.text ?? "",
      autoResultView(mission({ state: "aborted", automatic: true, reason: "timeout", last_landing: "safe_landing" }))?.text ?? "",
      autoResultView(mission({ state: "aborted", automatic: true, reason: "timeout" }))?.text ?? "",
    ].join(" ");
    expect(all.toLowerCase()).not.toContain("deliver");
    expect(all.toLowerCase()).not.toMatch(/motors? (are|is) cut/);
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
});
