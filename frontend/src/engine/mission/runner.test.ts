// Replays the runner_* fixtures (backend/tools/parity_traces.py runner_scripted, runner_quick,
// runner_manual, runner_auto, runner_avoid) into runner.ts and the TypeScript mixer, op by op; see
// testing/runnerReplay.ts for what is compared and how the line-up's pose fits are handled.
//
//   runner_scripted   tests/test_runner.py-style scripts (a recording link, synthetic detections, the
//                     line-up off): every start blocker, every abort reason, every landing outcome, the
//                     settle descent guard, dropouts, searching, automatic runs and their safe landings,
//                     avoidance with synthetic boxes (hidden sign, searching again, path_blocked and its
//                     evidence rules), the hover test, the setters and calibration.
//   runner_quick      closed loop: a cart refusing the start; the hover test and calibrate_arrival.
//   runner_manual     closed loop: manual runs with land on arrival on and off, the drift assist
//                     switching itself off, half the detections dropped.
//   runner_auto       closed loop: an automatic run from the ground that lands.
//   runner_avoid      closed loop, avoidance "hold": crossing (holds, resumes, lands), standing and
//                     blocked (path_blocked, landing where it is), nothing in the corridor.
import { describe, expect, it } from "vitest";
import { loadFixture, ParityStats } from "../testing/fixtures";
import { replayScenario, RUNNER_GROUPS, type RunnerFixture } from "../testing/runnerReplay";
import { ABORT_REASONS, BLOCKERS, RUNNER_CONFIG_DEFAULTS, SAFE_LANDING_REASONS } from "./runner";

const fixtures = Object.fromEntries(RUNNER_GROUPS.map((g) => [g, loadFixture<RunnerFixture>(g)])) as Record<
  (typeof RUNNER_GROUPS)[number],
  RunnerFixture
>;

describe("runner.ts constants", () => {
  it("abort reasons, blockers, safe-landing reasons and the RunnerConfig defaults are Python's", () => {
    const c = fixtures.runner_scripted.constants;
    expect([...ABORT_REASONS]).toEqual(c.ABORT_REASONS);
    expect([...BLOCKERS]).toEqual(c.BLOCKERS);
    expect([...SAFE_LANDING_REASONS].sort()).toEqual(c.SAFE_LANDING_REASONS);
    expect({ ...RUNNER_CONFIG_DEFAULTS }).toEqual(c.runner_config);
    expect(Object.keys(RUNNER_CONFIG_DEFAULTS)).toEqual(Object.keys(c.runner_config));
  });
});

const reasonsSeen = new Set<string>();
const statesSeen = new Set<string>();

for (const group of RUNNER_GROUPS) {
  describe(`runner.ts against runner.py: ${group}`, () => {
    for (const scenario of fixtures[group].scenarios) {
      it(`${scenario.name}: ${scenario.ops.length} ops`, () => {
        const stats = new ParityStats();
        const outcome = replayScenario(fixtures[group], scenario, stats);
        outcome.reasons.forEach((r) => reasonsSeen.add(r));
        outcome.states.forEach((s) => statesSeen.add(s));
        console.info(
          `${group}/${scenario.name}: ${outcome.ops} ops (${outcome.steps} steps, ${outcome.ticks} ticks), ` +
            `${outcome.storeWrites} store writes, ${outcome.logs} log lines, ${outcome.fits} pose fits ` +
            `(${outcome.fitsWithinParity} within 1e-9, ${outcome.fitsNeedingSpread} within ${16} x Python's spread, ` +
            `worst ${outcome.worstSpreadRatio.toFixed(2)} x); ${stats.summary("floats")}`,
        );
        expect(outcome.ops).toBe(scenario.ops.length);
      });
    }
  });
}

describe("the runner fixtures cover", () => {
  it("every abort reason and every state", () => {
    // (runs after the replays above: vitest runs the tests of a file in order)
    expect([...reasonsSeen].sort()).toEqual([...ABORT_REASONS].sort());
    expect([...statesSeen].sort()).toEqual(
      ["aborted", "aligning", "approaching", "arrived", "countdown", "done", "hover_test", "idle", "landing", "searching", "taking_off"].sort(),
    );
  });
});
