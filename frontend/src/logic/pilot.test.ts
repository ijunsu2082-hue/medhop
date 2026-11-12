import { describe, expect, it } from "vitest";
import type { Status } from "../api/types";
import {
  ACK_TEXT,
  ESTOP_CONFIRM_MS,
  doneMessage,
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
