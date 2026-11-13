import { describe, expect, it } from "vitest";
import type { MissionAvoid } from "../api/types";
import {
  AVOID_HINT,
  AVOID_HINT_PERSON_CHECK_OFF,
  AVOID_HINT_REAL,
  AVOID_HINT_STEPS,
  AVOID_SWITCH_LABEL,
  PATH_BLOCKED_NOT_LANDED_TEXT,
  PATH_BLOCKED_REASON,
  SCENARIOS,
  SCENARIO_REFUSAL_TEXT,
  SCENARIO_TEXT,
  abortReasonOnly,
  abortTextFor,
  avoidHint,
  avoidLine,
  obstacleNoun,
  obstaclePhrase,
  runAbortedText,
  scenarioRefusalText,
  scenarioText,
} from "./avoidWording";
import { ABORT_TEXT, abortText } from "./wording";

const avoid = (over: Partial<MissionAvoid>): MissionAvoid => ({
  mode: "hold",
  state: "clear",
  kind: null,
  distance_m: null,
  held_s: 0,
  ...over,
});

describe("avoidLine", () => {
  it("says what it is doing, distances to one decimal", () => {
    expect(avoidLine(avoid({ state: "clear" }))).toEqual({ tone: "pass", text: "Path clear" });
    expect(avoidLine(avoid({ state: "slow", kind: "person", distance_m: 2.94 }))).toEqual({
      tone: "warn",
      text: "Slowing: person 2.9 m ahead",
    });
    expect(avoidLine(avoid({ state: "hold", kind: "person", distance_m: 2.61, held_s: 12.1 }))).toEqual({
      tone: "warn",
      text: "Waiting: person 2.6 m ahead",
    });
    expect(avoidLine(avoid({ state: "hold", kind: "object", distance_m: 1.5 }))?.text).toBe("Waiting: object 1.5 m ahead");
    expect(avoidLine(avoid({ state: "blocked", kind: "person", distance_m: null }))).toEqual({ tone: "warn", text: "Path blocked" });
  });
  it("says closer than about 2.5 m when the distance is null", () => {
    expect(avoidLine(avoid({ state: "hold", kind: "person", distance_m: null }))?.text).toBe("Waiting: person closer than about 2.5 m");
    expect(avoidLine(avoid({ state: "hold", kind: "object", distance_m: null }))?.text).toBe("Waiting: object closer than about 2.5 m");
    expect(avoidLine(avoid({ state: "slow", kind: "object", distance_m: null }))?.text).toBe("Slowing: object closer than about 2.5 m");
  });
  it("an unknown kind is 'something'", () => {
    expect(avoidLine(avoid({ state: "hold", kind: null, distance_m: 2 }))?.text).toBe("Waiting: something 2.0 m ahead");
    expect(avoidLine(avoid({ state: "hold", kind: "dog", distance_m: null }))?.text).toBe("Waiting: something closer than about 2.5 m");
  });
  it("is never red: waiting and blocked are not faults", () => {
    for (const state of ["clear", "slow", "hold", "blocked", "brand_new"]) {
      expect(avoidLine(avoid({ state }))?.tone).not.toBe("fail");
    }
  });
  it("nothing when avoidance is off, has no state yet, or the backend is older", () => {
    expect(avoidLine(avoid({ mode: "off", state: "hold" }))).toBeNull();
    expect(avoidLine(avoid({ state: null }))).toBeNull();
    expect(avoidLine(null)).toBeNull();
    expect(avoidLine(undefined)).toBeNull();
  });
  it("an unknown state still says something, with its code", () => {
    expect(avoidLine(avoid({ state: "brand_new" }))?.text).toContain("(code: brand_new)");
  });
  it("phrases a seen thing", () => {
    expect(obstacleNoun("person")).toBe("person");
    expect(obstacleNoun("object")).toBe("object");
    expect(obstacleNoun(undefined)).toBe("something");
    expect(obstaclePhrase("person", 2.649)).toBe("person 2.6 m ahead");
    expect(obstaclePhrase("object", Number.NaN)).toBe("object closer than about 2.5 m");
  });
});

describe("the switch", () => {
  it("pins the label and every sentence", () => {
    expect(AVOID_SWITCH_LABEL).toBe("Wait for people and obstacles");
    expect(AVOID_HINT).toBe(
      "It slows and waits when something is in its way, and lands where it is if the way stays blocked. Tested in the simulator only.",
    );
    expect(AVOID_HINT_STEPS).toBe(
      "It slows and waits when something is in its way, and stops the run if the way stays blocked. Tested in the simulator only.",
    );
    expect(AVOID_HINT_REAL).toBe(
      "On this drone only people are detected, and only while the optional person check is running. With this off, a person in view stops the run.",
    );
    expect(AVOID_HINT_PERSON_CHECK_OFF).toBe("The person check is off now.");
  });
  it("adds what the real drone can detect only in real mode", () => {
    expect(avoidHint("sim", false)).toBe(AVOID_HINT);
    expect(avoidHint("sim", true, "steps")).toBe(AVOID_HINT_STEPS);
    expect(avoidHint("real", true)).toBe(`${AVOID_HINT} ${AVOID_HINT_REAL}`);
    expect(avoidHint("real", false)).toBe(`${AVOID_HINT} ${AVOID_HINT_REAL} ${AVOID_HINT_PERSON_CHECK_OFF}`);
    expect(avoidHint("real", true, "steps")).toBe(`${AVOID_HINT_STEPS} ${AVOID_HINT_REAL}`);
  });
});

describe("the simulator's corridor", () => {
  it("names every scenario in plain words, in order", () => {
    expect([...SCENARIOS]).toEqual(["empty", "crossing", "standing", "cart", "blocked"]);
    expect(SCENARIOS.map(scenarioText)).toEqual([
      "Empty corridor",
      "A person walks across",
      "A person stands in the way",
      "A trolley is in the way",
      "The corridor is blocked",
    ]);
    expect(Object.keys(SCENARIO_TEXT).sort()).toEqual([...SCENARIOS].sort());
  });
  it("an unknown scenario still shows, with its name", () => {
    expect(scenarioText("stairs")).toBe("Another corridor (code: stairs)");
    expect(scenarioText(" ")).toBe("Another corridor");
  });
  it("explains the backend's refusals", () => {
    expect(scenarioRefusalText(["not_simulator"])).toBe("The corridor can only be set in the simulator.");
    expect(scenarioRefusalText(["already_running"])).toBe("Wait for the run to end before changing the corridor.");
    expect(scenarioRefusalText(["brand_new"])).toContain("(code: brand_new)");
    expect(scenarioRefusalText([])).toBe("The backend refused to change the corridor.");
    expect(Object.keys(SCENARIO_REFUSAL_TEXT).sort()).toEqual(["already_running", "not_simulator"]);
  });
});

describe("how a blocked run ended", () => {
  it("pins path_blocked's words, landed or not", () => {
    expect(PATH_BLOCKED_REASON).toBe("The way stayed blocked for 25 seconds.");
    expect(abortText("path_blocked")).toBe(
      "The way stayed blocked for 25 seconds. The drone landed where it was: clear the corridor and send it again.",
    );
    expect(PATH_BLOCKED_NOT_LANDED_TEXT).toBe(
      "The way stayed blocked for 25 seconds. It did not land by itself: land it by hand, then clear the corridor.",
    );
  });
  it("says to land it by hand when the run did not send it down", () => {
    expect(abortTextFor("path_blocked", true)).toBe(ABORT_TEXT.path_blocked);
    expect(abortTextFor("path_blocked", false)).toBe(PATH_BLOCKED_NOT_LANDED_TEXT);
    expect(abortTextFor("path_blocked", false)).toMatch(/land it by hand/);
    // Every other reason reads as before, landed or not.
    for (const code of ["marker_lost", "timeout", "obstacle_in_view", "brand_new"]) {
      expect(abortTextFor(code, false)).toBe(abortText(code));
      expect(abortTextFor(code, true)).toBe(abortText(code));
    }
    expect(abortTextFor(null, false)).toBe("No reason was given.");
  });
  it("reads safe_landing from a run_aborted event", () => {
    const landed = {
      reason: "path_blocked",
      safe_landing: true,
      avoid: { mode: "hold", holds: 2, held_s: 25.1 },
      blocked_by: "timeout",
      obstacle_kind: "person",
      obstacle_distance_m: 2.61,
    };
    expect(runAbortedText(landed)).toBe(ABORT_TEXT.path_blocked);
    expect(runAbortedText({ ...landed, safe_landing: false })).toBe(PATH_BLOCKED_NOT_LANDED_TEXT);
    // A step-by-step run sends no safe_landing: it never lands by itself.
    expect(runAbortedText({ reason: "path_blocked", mode: "sim" })).toBe(PATH_BLOCKED_NOT_LANDED_TEXT);
    expect(runAbortedText({ reason: "pilot_link_lost" })).toMatch(/lost its control link/);
    expect(runAbortedText(null)).toBe("No reason was given.");
  });
  it("keeps only the reason where the message around it already says to land", () => {
    expect(abortReasonOnly("path_blocked")).toBe(PATH_BLOCKED_REASON);
    expect(abortReasonOnly("path_blocked")).not.toMatch(/landed/);
    expect(abortReasonOnly("marker_lost")).toBe(abortText("marker_lost"));
  });
});

describe("avoidance wording rules", () => {
  const all = [
    AVOID_SWITCH_LABEL,
    AVOID_HINT,
    AVOID_HINT_STEPS,
    AVOID_HINT_REAL,
    AVOID_HINT_PERSON_CHECK_OFF,
    PATH_BLOCKED_NOT_LANDED_TEXT,
    ABORT_TEXT.path_blocked,
    ABORT_TEXT.obstacle_in_view,
    ...Object.values(SCENARIO_TEXT),
    ...Object.values(SCENARIO_REFUSAL_TEXT),
    ...["clear", "slow", "hold", "blocked"].map((state) => avoidLine(avoid({ state, kind: "person", distance_m: 2.6 }))?.text ?? ""),
  ].join(" ");

  it("never says delivered, never calls it a safety system or says it prevents collisions, never AI", () => {
    const lower = all.toLowerCase();
    expect(lower).not.toContain("deliver");
    expect(lower).not.toContain("safety");
    expect(lower).not.toMatch(/prevent|collision|avoid crash|keeps? (you|people) safe|guarantee/);
    expect(all).not.toMatch(/\bAI\b/);
    expect(lower).not.toMatch(/\bsmart\b|\bintelligent\b|seamless/);
  });
  it("says what it does, and never that it goes round anything", () => {
    expect(all).toMatch(/waits/);
    expect(all).toMatch(/slows/);
    expect(all).toMatch(/lands where it is/);
    expect(all.toLowerCase()).not.toMatch(/go(es)? (a)?round|steers? (a)?round|detour/);
  });
  it("has no em or en dashes", () => {
    expect(all).not.toMatch(/[–—]/);
  });
});
