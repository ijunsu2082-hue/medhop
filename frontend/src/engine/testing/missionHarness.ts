// Completes the port of SimHarness of backend/tests/harness.py with the mission runner: the TypeScript
// simulator, the synthetic sign detector, the mixer and the MissionRunner in simulated time on one
// thread (testing/simHarness.ts is the shell; this adds what Python's SimHarness.__init__ builds around
// the runner: the CareStore, the person status, the runner itself and the pilot-input wiring).
//
// It is also the reference for wiring the runner into an engine loop:
//   runner = new MissionRunner(link, mixer, store, settings, { clock, wallClock, personStatus, ... })
//   onObservation = (obs, now) => runner.step(obs, now)            // every new frame, else null every 0.05 s
//   mixer.onPilotInput = (kind) => runner.abort(kind === "estop" ? "estop" : "pilot_took_over")
//   mixer.tick(now) at the control rate
// (Python's server also calls runner.notePilotInput() in the pilot-input callback, and runner.flush()
// after an abort it makes itself; SimHarness does neither, and this harness follows SimHarness.)
//
// Differences from Python: the store is in memory (MemoryStorage) instead of a temporary directory, so
// there is nothing to close; the detector and the simulator's noise come from PythonRandom generators
// (testing/simHarness.ts), so a seed gives another run than in Python.

import { CareStore, MemoryStorage } from "../care";
import { MissionRunner, type MissionRunnerOptions, type RunnerConfig, type RunnerState } from "../mission/runner";
import type { AvoidConfig } from "../mission/avoid";
import type { DriftAssistConfig, SteeringConfig } from "../mission/steering";
import type { Logger } from "../util/log";
import { NO_PERSON, type PersonStatus } from "../vision/person";
import { SimHarness, type SimHarnessOptions } from "./simHarness";

export interface MissionHarnessOptions extends Omit<SimHarnessOptions, "onObservation"> {
  runnerConfig?: RunnerConfig | null;
  steeringConfig?: SteeringConfig | null;
  driftAssistConfig?: DriftAssistConfig | null;
  avoidConfig?: AvoidConfig | null;
  /** default null: no pilot-link check (Python's SimHarness passes none) */
  pilotConnected?: MissionRunnerOptions["pilotConnected"];
  runnerLogger?: Logger;
}

export class MissionHarness {
  readonly harness: SimHarness;
  readonly store: CareStore;
  readonly runner: MissionRunner;
  /** What the person check reports (Python: harness.person). */
  person: PersonStatus = NO_PERSON;

  constructor(options: MissionHarnessOptions = {}) {
    const { runnerConfig, steeringConfig, driftAssistConfig, avoidConfig, pilotConnected, runnerLogger, ...simOptions } = options;
    this.harness = new SimHarness(simOptions);
    const h = this.harness;
    this.store = new CareStore(new MemoryStorage(), { wallClock: () => h.wall() });
    this.runner = new MissionRunner(h.sim, h.mixer, this.store, h.settings, {
      clock: h.clock.now,
      wallClock: () => h.wall(),
      personStatus: () => this.person,
      steeringConfig: steeringConfig ?? null,
      config: runnerConfig ?? null,
      driftAssistConfig: driftAssistConfig ?? null,
      avoidConfig: avoidConfig ?? null,
      pilotConnected: pilotConnected ?? null,
      ...(runnerLogger ? { logger: runnerLogger } : {}),
    });
    h.onObservation = (obs, now) => this.runner.step(obs, now);
    h.mixer.onPilotInput = (kind) => {
      this.runner.abort(kind === "estop" ? "estop" : "pilot_took_over");
    };
  }

  get sim() {
    return this.harness.sim;
  }

  get mixer() {
    return this.harness.mixer;
  }

  get clock() {
    return this.harness.clock;
  }

  step(): void {
    this.harness.step();
  }

  /** Advance simulated time. Returns true when `until` became true. */
  run(seconds: number, until?: (h: MissionHarness) => boolean): boolean {
    return this.harness.run(seconds, until === undefined ? undefined : () => until(this));
  }

  runUntilState(states: RunnerState | readonly RunnerState[], seconds = 60.0): boolean {
    const wanted: readonly RunnerState[] = typeof states === "string" ? [states] : states;
    return this.run(seconds, (h) => wanted.includes(h.runner.state));
  }

  /** Let the first frames arrive before a run is started. */
  warmUp(seconds = 1.0): void {
    this.run(seconds);
  }
}
