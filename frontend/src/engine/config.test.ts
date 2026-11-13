// Replays __fixtures__/config.json (backend/tools/parity_traces.py config): Settings, the config
// dataclass defaults, the mixer and steering constants and the marker data shapes, against Python.
import { describe, expect, it } from "vitest";
import { batteryCheckEnabled, makeSettings, type SettingsInit } from "./config";
import * as mixer from "./mixer";
import { DISABLED_OFF_AXIS, DRIFT_ASSIST_CONFIG_DEFAULTS, STEERING_CONFIG_DEFAULTS, Steering } from "./mission/steering";
import { assertNoMismatches, compareValues, loadFixture, PARITY } from "./testing/fixtures";
import { ValueError } from "./util/num";
import * as marker from "./vision/marker";

interface ConfigFixture {
  settings: { init: SettingsInit; out?: Record<string, unknown>; error?: string }[];
  steering_config: Record<string, number>;
  drift_assist_config: Record<string, number>;
  steering_constants: { YAW_LOG_S: number; DISABLED_OFF_AXIS: string };
  mixer_constants: Record<string, unknown>;
  marker_constants: Record<string, unknown>;
  marker_obs_defaults: { ts: number; height: number; frame_w: number; frame_h: number };
  observation_defaults: { brightness: number };
  marker_obs_size: { width: number; height: number; size: number }[];
}

const fx = loadFixture<ConfigFixture>("config");

describe("Settings (config.py)", () => {
  it("defaults, normalisation, the derived arrive width and every error message match", () => {
    expect(fx.settings.length).toBeGreaterThan(40);
    for (const c of fx.settings) {
      const label = JSON.stringify(c.init);
      if (c.error !== undefined) {
        expect(() => makeSettings(c.init), label).toThrow(ValueError);
        expect(() => makeSettings(c.init), label).toThrow(c.error);
        continue;
      }
      const s = makeSettings(c.init);
      const got = { ...s, battery_check_enabled: batteryCheckEnabled(s) };
      // arrive_width goes through Math.tan (the C library's tan may differ in the last bit); the rest is exact
      assertNoMismatches(compareValues(got, c.out, PARITY), label);
      const { arrive_width: _arrive, ...exactPart } = got;
      const { arrive_width: _expected, ...exactExpected } = c.out ?? {};
      expect(exactPart, label).toEqual(exactExpected);
    }
  });
});

describe("config dataclass defaults and constants", () => {
  it("SteeringConfig and DriftAssistConfig defaults are Python's, field for field", () => {
    expect({ ...STEERING_CONFIG_DEFAULTS }).toEqual(fx.steering_config);
    expect({ ...DRIFT_ASSIST_CONFIG_DEFAULTS }).toEqual(fx.drift_assist_config);
  });

  it("steering constants", () => {
    expect(Steering.YAW_LOG_S).toBe(fx.steering_constants.YAW_LOG_S);
    expect(DISABLED_OFF_AXIS).toBe(fx.steering_constants.DISABLED_OFF_AXIS);
  });

  it("mixer constants", () => {
    const exported = mixer as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(fx.mixer_constants)) expect(exported[name], name).toEqual(value);
  });

  it("marker constants and data shapes", () => {
    const exported = marker as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(fx.marker_constants)) expect(exported[name], name).toEqual(value);
    const obs = new marker.MarkerObs({ id: 7, cx: 0.5, cy: 0.5, width: 0.1, corners: [] });
    expect({ ts: obs.ts, height: obs.height, frame_w: obs.frame_w, frame_h: obs.frame_h }).toEqual(fx.marker_obs_defaults);
    for (const c of fx.marker_obs_size) {
      const m = new marker.MarkerObs({ id: 7, cx: 0.5, cy: 0.5, width: c.width, height: c.height, corners: [] });
      expect(m.size).toBe(c.size);
    }
    const seen = new marker.Observation({ ts: 1.0, seq: 1, marker: null });
    expect(seen.brightness).toBe(fx.observation_defaults.brightness);
    expect(new marker.Observation({ ts: 1.0, seq: 2, marker: obs, brightness: 80 }).marker?.size).toBe(0.1);
  });
});
