#!/usr/bin/env python3
"""Record reference traces from the Python flight logic, for the TypeScript port in frontend/src/engine.

    python tools/parity_traces.py all              # rewrite every fixture group
    python tools/parity_traces.py steering pose    # only these groups
    python tools/parity_traces.py --check all      # compare with the committed files, write nothing

Groups: steering (mission/steering.py), pose (vision/pose.py), mixer (mixer.py, driven through the
RecordingLink of tests/harness.py), num (the Python number semantics the port mirrors: round, hypot,
sum, median, repr, clamp), rng (random.Random), config (Settings and the config dataclass defaults),
sim_physics (drone/sim.py stepped with its noise at zero), sim_actors (drone/sim_actors.py and the
boxes frames carry), projection (the simulator's pinhole camera), sim_harness (SimHarness.step of
tests/harness.py with a scripted stand-in for the runner), marker7 (the station sign's ArUco pattern as
OpenCV draws it, for the line drawing in frontend/src/scene), avoid (mission/avoid.py: the estimates
from a box and the state machine), the runner traces (mission/runner.py and the mixer it drives,
recorded call by call: runner_scripted with synthetic detections, runner_quick, runner_manual,
runner_auto and runner_avoid from closed-loop SimHarness runs; see "runner_*" below), and
detector_calibration: the real OpenCV detector run on the simulator's own pictures and compared with
geometric truth. That last one is measured rather than replayed and takes about a minute; the closed-
loop runner groups take about 40 s together:

    python tools/parity_traces.py detector_calibration    # measure again
    python tools/parity_traces.py replayed                 # every group except the measured one

Each group writes frontend/src/engine/__fixtures__/<group>.json. The vitest suites under
frontend/src/engine replay every recorded input through the TypeScript port and compare the outputs;
tests/test_parity_fixtures.py regenerates the groups in memory and compares them with the committed
files, so a change to the Python that is not followed by a regeneration fails the tests.

Output is deterministic: fixed seeds, no clocks, no timestamps. Floats are written at full precision
(Python's repr, which round-trips exactly); NaN and the infinities, which JSON cannot carry, are written
as {"$float": "nan" | "inf" | "-inf"}. Recorded inputs are rounded to a few decimals where that keeps
the files small: they are inputs, so both sides use exactly the recorded value.

Adding a group: write `build_<name>() -> dict` below (plain values; keep each input next to its
output), register it in GROUPS, run `python tools/parity_traces.py <name>`, and add a vitest suite that
reads the file with loadFixture("<name>") from frontend/src/engine/testing/fixtures.ts.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import math
import random
import statistics
import sys
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from unittest import mock  # noqa: E402

import numpy as np  # noqa: E402

from medhop import mixer as mixer_module  # noqa: E402
from medhop.config import Settings  # noqa: E402
from medhop.drone.base import clamp  # noqa: E402
from medhop.mission.steering import (  # noqa: E402
    DISABLED_OFF_AXIS, DriftAssist, DriftAssistConfig, MarkerSample, Steering, SteeringConfig,
    forward_for_width, limit_rise, marker_skew, pending_yaw, predict_cx, steer,
)
from medhop.mixer import ControlMixer  # noqa: E402
from medhop.vision import marker as marker_module  # noqa: E402
from medhop.vision.pose import _project, fit_sign_pose  # noqa: E402

FIXTURE_DIR = BACKEND_DIR.parent / "frontend" / "src" / "engine" / "__fixtures__"
NAN = float("nan")
INF = float("inf")


# ---------------------------------------------------------------------------------------------- #
# encoding and writing

def encode(value: Any) -> Any:
    """Plain JSON values: tuples and arrays become lists, non-finite floats become {"$float": ...}."""
    if value is None or isinstance(value, (bool, np.bool_)):
        return None if value is None else bool(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (int, np.integer)):
        return int(value)
    if isinstance(value, (float, np.floating)):
        v = float(value)
        if math.isnan(v):
            return {"$float": "nan"}
        if math.isinf(v):
            return {"$float": "inf" if v > 0 else "-inf"}
        return v
    if isinstance(value, dict):
        return {str(k): encode(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, np.ndarray)):
        return [encode(v) for v in value]
    if dataclasses.is_dataclass(value):
        return encode(dataclasses.asdict(value))
    raise TypeError(f"cannot encode {type(value).__name__}")


def render(value: Any, indent: int = 0, width: int = 118, flat_from: Optional[int] = None) -> str:
    """Compact JSON, broken into one item per line wherever a line would get long (diff-friendly). From
    nesting depth `flat_from` on, values stay on one line however long (the runner groups: one op per line)."""
    flat = json.dumps(value, separators=(",", ":"), allow_nan=False)
    if (len(flat) + indent <= width or not isinstance(value, (list, dict)) or not value
            or (flat_from is not None and indent >= flat_from)):
        return flat
    pad = " " * (indent + 1)
    if isinstance(value, list):
        inner = ",\n".join(pad + render(item, indent + 1, width, flat_from) for item in value)
        return "[\n" + inner + "\n" + " " * indent + "]"
    inner = ",\n".join(pad + json.dumps(key) + ":" + render(item, indent + 1, width, flat_from)
                       for key, item in value.items())
    return "{\n" + inner + "\n" + " " * indent + "}"


def decode_floats(obj: Dict[str, Any]) -> Any:
    """json.loads object_hook: undo the {"$float": ...} tags."""
    if len(obj) == 1 and "$float" in obj:
        return {"nan": NAN, "inf": INF, "-inf": -INF}[obj["$float"]]
    return obj


def r9(x: float) -> float:
    """Round a recorded input (not an output) to keep the files small."""
    return round(float(x), 9)


def r6(x: float) -> float:
    return round(float(x), 6)


# ---------------------------------------------------------------------------------------------- #
# num: the Python number semantics that the TypeScript helpers in engine/util/num.ts mirror

def _rounded(v: float, ndigits: Optional[int]) -> Any:
    try:
        return round(v) if ndigits is None else round(v, ndigits)
    except (ValueError, OverflowError) as exc:
        return {"error": type(exc).__name__}


def build_num() -> dict:
    rng = random.Random(7)
    values = [0.0, -0.0, 0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.125, 0.375, -0.125, 2.675, 1.005, 0.045, 0.0625,
              1234.5678, -9.87654321, 1e-7, 3.14159e10, 123456789.125, 0.30000000000000004, 0.15, 0.25,
              1250.0, -0.0049999, 5e-324, 1e22, NAN, INF, -INF]
    values += [r9(rng.uniform(-10, 10)) for _ in range(12)]
    values += [rng.uniform(-10, 10) for _ in range(12)]
    values += [rng.uniform(-1, 1) * 10.0 ** rng.randint(-8, 8) for _ in range(16)]
    rounding = []
    for v in values:
        for nd in (None, 0, 1, 2, 3, 4, 7, -1, -2):
            if nd is None and math.isfinite(v) and abs(v) > 1e15:
                continue
            rounding.append({"x": v, "ndigits": nd, "out": _rounded(v, nd)})

    fixed = [{"x": v, "digits": d, "out": format(v, f".{d}f")}
             for v in values if not (math.isfinite(v) and abs(v) > 1e15) for d in (0, 1, 3)]

    reprs = [{"x": v, "out": repr(v)} for v in values + [1.0, 100.0, 0.1, 0.2, 1 / 3, 1e16, 1e15, 9999999999999998.0,
                                                          1e-4, 1e-5, 1.5e-5, 123456789012345680.0, 1e100,
                                                          1.7976931348623157e308, 2.0 ** -1074, -2.5e-7]]

    hypot = []
    for _ in range(300):
        a = rng.uniform(-1, 1) * 10.0 ** rng.randint(-6, 6)
        b = rng.uniform(-1, 1) * 10.0 ** rng.randint(-6, 6)
        hypot.append([a, b])
    for _ in range(300):   # corner differences in pixels, as marker_skew sees them
        hypot.append([r6(rng.uniform(-600, 600)), r6(rng.uniform(-400, 400))])
    hypot += [[], [3.0], [-3.0], [0.0, 0.0], [3.0, 4.0], [-3.0, -4.0], [INF, NAN], [NAN, 1.0], [-INF, 2.0],
              [1e308, 1e308], [5e-324, 5e-324], [1e-310, 3e-310], [2.2250738585072014e-308, 1e-310],
              [1.0, 2.0, 3.0], [1e-200, 1e200], [0.1, 0.2, 0.3, 0.4], [1e-160, 1e-160], [12.0, 0.0]]
    hypot_cases = [{"args": args, "out": math.hypot(*args)} for args in hypot]

    sums = [[], [0.1] * 10, [1e100, 1.0, -1e100], [1e16, 1.0, 1.0], [INF, 1.0], [INF, -INF], [NAN, 1.0],
            [-0.0], [-0.0, -0.0], [0.0, -0.0], [1e308, 1e308], [0.15, 0.15, -0.15, 0.14999999]]
    for _ in range(30):
        n = rng.randint(1, 60)
        scale = 10.0 ** rng.randint(-3, 3)
        sums.append([rng.uniform(-1, 1) * scale for _ in range(n)])
    for _ in range(6):   # roll values like the ones DriftAssist averages
        sums.append([rng.uniform(-0.15, 0.15) for _ in range(rng.randint(10, 45))])
    sum_cases = [{"values": v, "out": sum(v)} for v in sums]

    medians = [[1.0], [3.0, 1.0], [2.0, 2.0, 1.0], [0.1, 0.2, 0.3, 0.4], [-0.0, 0.0], [1e300, 1e300]]
    for _ in range(20):
        medians.append([r6(rng.uniform(-1, 1)) for _ in range(rng.randint(1, 12))])
    median_cases = [{"values": v, "out": statistics.median(v)} for v in medians]

    clamps = []
    for value in (-2.0, -1.0, -0.3, -0.0, 0.0, 0.2, 0.31, 1.0, 1.5, NAN, INF, -INF):
        for low, high in ((-1.0, 1.0), (-0.3, 0.3), (0.2, 1.0), (-0.15, 0.15)):
            clamps.append({"args": [value, low, high], "out": clamp(value, low, high)})

    angles = [0.0, 1.0, 35.0, 70.0, -12.5, 90.0, 180.0, 360.0, 1e-9, 123.456] + [rng.uniform(-400, 400) for _ in range(10)]
    angle_cases = [{"x": a, "radians": math.radians(a), "degrees": math.degrees(a)} for a in angles]

    # The C library's exp/sin/cos/tan/atan2 are not required to be correctly rounded; these record what
    # this Python gives, so the TypeScript test can report how often the browser's functions differ.
    libm = []
    for _ in range(60):
        dt = rng.uniform(0.0, 0.3)
        tau = rng.choice((0.4, 0.8, 0.25))
        libm.append({"f": "exp", "args": [-dt / tau], "out": math.exp(-dt / tau)})
    for _ in range(40):
        a = rng.uniform(-1.0, 1.0)
        libm.append({"f": "sin", "args": [a], "out": math.sin(a)})
        libm.append({"f": "cos", "args": [a], "out": math.cos(a)})
    for hfov in (30.0, 60.0, 70.0, 90.0, 150.0):
        half = math.radians(hfov) / 2.0
        libm.append({"f": "tan", "args": [half], "out": math.tan(half)})
    for _ in range(40):
        y, x = rng.uniform(-600, 600), rng.uniform(300, 1200)
        libm.append({"f": "atan2", "args": [y, x], "out": math.atan2(y, x)})

    return {"round": rounding, "format_fixed": fixed, "repr": reprs, "hypot": hypot_cases, "sum": sum_cases,
            "median": median_cases, "clamp": clamps, "angles": angle_cases, "libm": libm}


# ---------------------------------------------------------------------------------------------- #
# rng: random.Random, which tests/harness.py uses for detection dropouts

def build_rng() -> dict:
    cases = []
    for seed in (0, 1, 42, 12345, 2 ** 32 + 5, 2 ** 64 + 12345, -7):
        r = random.Random(seed)
        case: Dict[str, Any] = {"seed": str(seed)}
        case["random"] = [r.random() for _ in range(30)]
        case["uniform"] = [[a, b, r.uniform(a, b)] for a, b in ((0.0, 1.0), (-0.5, 0.5), (2.0, 7.5), (1.0, -1.0))]
        case["gauss"] = [[mu, sigma, r.gauss(mu, sigma)] for mu, sigma in
                         ((0.0, 1.0), (0.0, 1.0), (0.0, 1.0), (1.5, 0.25), (-2.0, 3.0), (0.0, 0.002), (0.0, 1.0))]
        case["getrandbits"] = [[k, r.getrandbits(k)] for k in (1, 5, 16, 31, 32, 0, 33, 53)]
        case["randrange"] = [[n, r.randrange(n)] for n in (1, 2, 3, 7, 8, 10, 1000, 2 ** 31 - 1, 2 ** 32, 2 ** 40 + 3)]
        case["after"] = [r.random() for _ in range(5)]
        cases.append(case)
    # Many draws from one generator: crosses the 624-word state refills several times.
    r = random.Random(2026)
    long_run = [r.random() for _ in range(2000)]
    return {"cases": cases, "long_run": {"seed": "2026", "every_100th": long_run[::100], "last": long_run[-1]}}


# ---------------------------------------------------------------------------------------------- #
# config: Settings and the dataclass defaults the TypeScript port copies

SETTINGS_FIELDS = ("drone", "control_rate", "marker_id", "marker_size_m", "arrive_width", "land_distance_m",
                   "person_check", "battery_low_raw", "telemetry_fresh_s", "hover_max_excursion_m", "grace_min",
                   "camera_hfov_deg", "sim_camera", "avoid")
MIXER_CONSTANTS = ("PILOT_ACTIVE_S", "MISSION_FRESH_S", "VIDEO_STALE_S", "PILOT_RAMP_PER_S", "TRIM_LIMIT",
                   "MISSION_ROLL_LIMIT", "MAX_STICK_MIN", "MAX_STICK_MAX", "TOGGLE_GUARD_S", "LANDING_GUARD_S",
                   "MISSION_TOGGLE_PILOT_QUIET_S", "STICKS_BLOCK_AFTER_S", "ESTOP_CONFIRM_S", "ESTOP_MAX_STEP_S",
                   "ESTOP_ACTIVE", "TOGGLE_GUARD", "LANDING_IN_PROGRESS", "DRONE_LINK_DOWN", "NEUTRAL")


def _settings_case(init: Dict[str, Any]) -> Dict[str, Any]:
    try:
        s = Settings(**init)
    except ValueError as exc:
        return {"init": init, "error": str(exc)}
    out = {name: getattr(s, name) for name in SETTINGS_FIELDS}
    out["battery_check_enabled"] = s.battery_check_enabled
    return {"init": init, "out": out}


def build_config() -> dict:
    settings = [_settings_case({})]
    for init in ({"drone": " REAL "}, {"person_check": "ON"}, {"sim_camera": "Drone"}, {"battery_low_raw": 30},
                 {"arrive_width": 0.25}, {"land_distance_m": 0.35}, {"land_distance_m": 3.0},
                 {"marker_size_m": 0.1, "camera_hfov_deg": 90.0, "land_distance_m": 1.2},
                 {"drone": "plane"}, {"person_check": "maybe"}, {"sim_camera": "4k"}, {"control_rate": 0.5},
                 {"control_rate": NAN}, {"marker_id": 50}, {"marker_id": -1}, {"marker_size_m": 0.01},
                 {"grace_min": -1}, {"hover_max_excursion_m": 6.0}, {"camera_hfov_deg": 20.0},
                 {"land_distance_m": 0.2}, {"marker_size_m": 0.02, "camera_hfov_deg": 150.0, "land_distance_m": 3.0},
                 {"marker_size_m": 1.0, "camera_hfov_deg": 30.0, "land_distance_m": 0.35}, {"arrive_width": 0.9},
                 {"arrive_width": 0.02}, {"avoid": " HOLD "}, {"avoid": "Off"}, {"avoid": "go_around"},
                 {"avoid": "pass", "drone": "plane"}):
        settings.append(_settings_case(init))
    for size in (0.05, 0.18, 0.3):
        for hfov in (40.0, 70.0, 110.0):
            for land in (0.4, 0.9, 2.5):
                settings.append(_settings_case({"marker_size_m": size, "camera_hfov_deg": hfov, "land_distance_m": land}))

    marker_obs = []
    for width, height in ((0.05, 0.04), (0.04, 0.05), (0.0, 0.0), (0.1, 0.1)):
        obs = marker_module.MarkerObs(id=7, cx=0.5, cy=0.5, width=width, corners=((0, 0),) * 4, height=height)
        marker_obs.append({"width": width, "height": height, "size": obs.size})
    defaults = marker_module.MarkerObs(id=7, cx=0.5, cy=0.5, width=0.1, corners=())
    observation = marker_module.Observation(ts=1.0, seq=1, marker=None)

    return {
        "settings": settings,
        "steering_config": dataclasses.asdict(SteeringConfig()),
        "drift_assist_config": dataclasses.asdict(DriftAssistConfig()),
        "steering_constants": {"YAW_LOG_S": Steering.YAW_LOG_S, "DISABLED_OFF_AXIS": DISABLED_OFF_AXIS},
        "mixer_constants": {name: getattr(mixer_module, name) for name in MIXER_CONSTANTS},
        "marker_constants": {
            "ARUCO_DICT_NAME": marker_module.ARUCO_DICT_NAME, "A4_WIDTH_M": marker_module.A4_WIDTH_M,
            "A4_HEIGHT_M": marker_module.A4_HEIGHT_M, "SIGN_TOP_MARGIN_M": marker_module.SIGN_TOP_MARGIN_M,
            "SIGN_CAPTION": marker_module.SIGN_CAPTION, "MIN_WIDTH": marker_module.MarkerDetector.MIN_WIDTH,
        },
        "marker_obs_defaults": {"ts": defaults.ts, "height": defaults.height, "frame_w": defaults.frame_w,
                                "frame_h": defaults.frame_h},
        "observation_defaults": {"brightness": observation.brightness},
        "marker_obs_size": marker_obs,
    }


# ---------------------------------------------------------------------------------------------- #
# steering

STEERING_CONFIGS = {
    "default": SteeringConfig(),
    "custom": SteeringConfig(latency_s=0.3, yaw_rate_fw_per_s=1.8, yaw_gain=1.4, yaw_max=0.4, yaw_deadband=0.02,
                             forward_window=0.1, forward_max=0.3, forward_near=0.05, taper_start=0.6,
                             rise_per_s=2.0, search_yaw=0.2, creep_yaw=0.1),
    "taper_one": SteeringConfig(taper_start=1.0),
    "taper_zero": SteeringConfig(taper_start=0.0),
    "near_above_max": SteeringConfig(forward_near=0.3),
}


def _samples(rows: Sequence[Sequence[float]]) -> List[MarkerSample]:
    return [MarkerSample(ts=ts, cx=cx, width=width) for ts, cx, width in rows]


def _random_log(rng: random.Random, start: float, n: int) -> List[List[float]]:
    t, log = start, []
    for _ in range(n):
        log.append([r9(t), r6(rng.uniform(-0.3, 0.3))])
        t += rng.uniform(0.02, 0.09)
    return log


def _steering_functions(rng: random.Random) -> dict:
    logs = [
        [],
        [[10.0, 0.2]],
        [[10.0, 0.2], [10.1, -0.1], [10.25, 0.3]],
        [[10.0, 0.25], [10.05, 0.25], [10.05, -0.25], [10.4, 0.0]],      # two commands at the same time
        [[10.3, 0.1], [10.1, 0.2], [10.2, -0.3]],                           # out of order (callers keep it sorted)
        _random_log(rng, 9.6, 20),
    ]
    pending = []
    for log in logs:
        for start in (9.0, 10.0, 10.07, 10.25, 10.5, 12.0):
            for now in (9.5, 10.05, 10.3, 10.6, 13.0):
                pending.append({"yaw_log": log, "start": start, "now": now, "out": pending_yaw(log, start, now)})

    predict = []
    for i in range(60):
        cfg_name = "custom" if i % 3 == 2 else "default"
        cfg = STEERING_CONFIGS[cfg_name]
        now = r9(20.0 + rng.uniform(0.0, 1.0))
        rows = [[r9(now - rng.uniform(0.0, 0.8) - 0.1 * k), r6(rng.uniform(0.0, 1.0)), r6(rng.uniform(0.02, 0.3))]
                for k in range(1 + i % 3)][::-1]
        log = _random_log(rng, now - rng.uniform(0.3, 1.5), rng.randint(0, 14))
        predict.append({"history": rows, "yaw_log": log, "now": now, "cfg": cfg_name,
                        "out": predict_cx(_samples(rows), log, now, cfg)})

    forward = []
    for cfg_name in ("default", "custom", "taper_one", "taper_zero", "near_above_max"):
        cfg = STEERING_CONFIGS[cfg_name]
        for arrive in (0.0, 0.1, 0.16, 0.2963, 0.5):
            start = arrive * cfg.taper_start
            widths = [-0.1, 0.0, 0.02, start - 1e-12, start, start + 1e-12, (start + arrive) / 2, arrive - 1e-12,
                      arrive, arrive + 1e-12, 1.0, NAN]
            for w in widths:
                forward.append({"width": w, "arrive_width": arrive, "cfg": cfg_name,
                                "out": forward_for_width(w, arrive, cfg)})

    steer_cases = [{"history": [], "yaw_log": [], "now": 10.0, "arrive_width": 0.16, "cfg": None,
                    "out": steer([], (), 10.0, 0.16)}]
    d = STEERING_CONFIGS["default"]
    edge_cx = [0.5, 0.5 + d.yaw_deadband, 0.5 - d.yaw_deadband, 0.5 + d.forward_window, 0.5 - d.forward_window,
               0.5 + d.forward_window + 1e-12, 0.0, 1.0, -0.2, 1.3, NAN]
    for cx in edge_cx:
        rows = [[10.0, cx, 0.05]]
        steer_cases.append({"history": rows, "yaw_log": [], "now": 10.0, "arrive_width": 0.16, "cfg": "default",
                            "out": steer(_samples(rows), (), 10.0, 0.16, d)})
    for i in range(160):
        cfg_name = (None, "default", "custom", "taper_one")[i % 4]
        cfg = None if cfg_name is None else STEERING_CONFIGS[cfg_name]
        now = r9(30.0 + rng.uniform(0.0, 1.0))
        rows = [[r9(now - rng.uniform(0.0, 0.7) - 0.07 * k), r6(rng.uniform(0.2, 0.8)), r6(rng.uniform(0.01, 0.4))]
                for k in range(1 + i % 2)][::-1]
        log = _random_log(rng, now - rng.uniform(0.3, 1.2), rng.randint(0, 12))
        arrive = rng.choice((0.1, 0.16, 0.2963, 0.4))
        steer_cases.append({"history": rows, "yaw_log": log, "now": now, "arrive_width": arrive, "cfg": cfg_name,
                            "out": steer(_samples(rows), log, now, arrive, cfg)})

    rise = []
    for previous in (-0.5, -0.1, -0.0, 0.0, 0.1, 0.3, NAN):
        for target in (-0.6, -0.1, -0.0, 0.0, 0.05, 0.1, 0.4, NAN):
            for dt in (-0.1, 0.0, 0.05, 0.5):
                for rate in (0.0, 1.0, 2.5):
                    rise.append([previous, target, dt, rate, limit_rise(previous, target, dt, rate)])

    skew = []
    square = [[100.0, 100.0], [200.0, 100.0], [200.0, 200.0], [100.0, 200.0]]
    skew_inputs = [square, [[0.0, 0.0]] * 4, [[100.0, 100.0], [200.0, 90.0], [200.0, 210.0], [100.0, 200.0]],
                   [[100.0, 90.0], [200.0, 100.0], [200.0, 200.0], [100.0, 210.0]],
                   [[5.0, 5.0], [5.0, 5.0], [5.0, 9.0], [5.0, 5.0]]]
    for _ in range(35):
        cx, cy, half = rng.uniform(100, 540), rng.uniform(80, 280), rng.uniform(8, 120)
        skew_inputs.append([[r6(cx + sx * half + rng.uniform(-6, 6)), r6(cy + sy * half + rng.uniform(-6, 6))]
                            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    for corners in skew_inputs:
        skew.append({"corners": corners, "out": marker_skew(corners)})

    return {"pending_yaw": pending, "predict_cx": predict, "forward_for_width": forward, "steer": steer_cases,
            "limit_rise": {"fields": ["previous", "target", "dt", "rise_per_s", "out"], "rows": rise},
            "marker_skew": skew}


def _approach_sequence(name: str, cfg_name: str, seed: int, n_steps: int, true_rate: float,
                       true_latency: float, arrive: float) -> dict:
    """A toy closed loop around Steering: the marker moves with the yaw sent, frames arrive late and
    sometimes not at all, with time gaps, a clock step backwards and a reset in between."""
    rng = random.Random(seed)
    cfg = STEERING_CONFIGS[cfg_name]
    st = Steering(cfg)
    t = 1000.0
    heading = rng.uniform(-0.3, 0.3)
    dist = rng.uniform(2.0, 4.0)
    k_width = 0.18 * 0.714
    states: List[Tuple[float, float, float]] = [(t, 0.5 + heading, k_width / dist)]
    history: List[List[float]] = []
    next_frame = t
    yaw = pitch = 0.0
    prev_frame_ts: Optional[float] = None
    lost_for = 0
    steps: List[dict] = []
    gaps = {n_steps // 5, n_steps // 2}
    back = n_steps // 3
    reset_at = (2 * n_steps) // 3
    for i in range(n_steps):
        dt = 0.05 + rng.uniform(-0.004, 0.004)
        if i in gaps:
            dt += 0.8
        if i == back:
            dt = -0.1
        t = r9(t + dt)
        if dt > 0:
            heading += -true_rate * yaw * dt + rng.gauss(0.0, 0.002)
            dist = max(0.3, dist - 1.2 * pitch * dt)
        states.append((t, 0.5 + heading, k_width / dist))
        if i == reset_at:
            st.reset()
            history = []
            steps.append({"op": "reset", "out": None})
            continue
        sample = None
        if t >= next_frame:
            next_frame = t + 1.0 / 15.0 + rng.uniform(-0.01, 0.01)
            dropped = rng.random() < (0.6 if (n_steps // 4) < i < (n_steps // 4 + 25) else 0.08)
            if not dropped:
                seen = [s for s in states if s[0] <= t - true_latency] or states[:1]
                _ts, cx, width = seen[-1]
                sample = [t, r6(cx), r6(width)]
        if sample is not None:
            lost_for = 0
            history = (history + [sample])[-2:]
            no_forward = history[-1][2] >= arrive * 1.05
            out = st.update(_samples(history), t, arrive, no_forward)
            steps.append({"op": "update", "history": history, "now": t, "arrive_width": arrive,
                          "no_forward": no_forward, "out": out})
            if prev_frame_ts is not None:
                steps.append({"op": "yaw_seen_between", "earlier": prev_frame_ts, "later": t,
                              "out": st.yaw_seen_between(prev_frame_ts, t)})
            prev_frame_ts = t
        else:
            lost_for += 1
            if lost_for > 12:
                direction = 1.0 if heading >= 0 else -1.0
                out = st.search(t, direction, lost_for > 20)
                steps.append({"op": "search", "now": t, "direction": direction, "creep": lost_for > 20, "out": out})
            elif history and lost_for <= 3:
                out = st.update(_samples(history), t, arrive, False)
                steps.append({"op": "update", "history": history, "now": t, "arrive_width": arrive,
                              "no_forward": False, "out": out})
            else:
                out = st.neutral(t)
                steps.append({"op": "neutral", "now": t, "out": out})
        yaw, pitch = out
        if i % 37 == 0:
            earlier, later = r9(t - 5.0), r9(t - 0.2)
            steps.append({"op": "yaw_seen_between", "earlier": earlier, "later": later,
                          "out": st.yaw_seen_between(earlier, later)})
    return {"name": name, "cfg": cfg_name, "steps": steps}


def _shape_sequence(name: str, cfg_name: str, seed: int, n_steps: int) -> dict:
    """Arbitrary targets through shape/search/neutral/update, including sign flips, a NaN target, an empty
    history, odd search directions, long gaps and resets."""
    rng = random.Random(seed)
    st = Steering(STEERING_CONFIGS[cfg_name])
    t = 500.0
    steps: List[dict] = []
    for i in range(n_steps):
        t = r9(t + rng.choice((0.05, 0.05, 0.05, 0.01, 0.2, 0.7, 0.0)))
        r = rng.random()
        if i == n_steps // 2:
            out = st.shape(NAN, 0.1, t)
            steps.append({"op": "shape", "yaw": NAN, "pitch": 0.1, "now": t, "out": out})
        elif r < 0.45:
            yaw = rng.choice((0.0, -0.0, r6(rng.uniform(-1.0, 1.0)), r6(rng.uniform(-0.3, 0.3))))
            pitch = rng.choice((0.0, r6(rng.uniform(-0.3, 0.3))))
            out = st.shape(yaw, pitch, t)
            steps.append({"op": "shape", "yaw": yaw, "pitch": pitch, "now": t, "out": out})
        elif r < 0.62:
            direction = rng.choice((1.0, -1.0, 0.0, -0.0, 2.5, NAN))
            creep = rng.random() < 0.5
            out = st.search(t, direction, creep)
            steps.append({"op": "search", "now": t, "direction": direction, "creep": creep, "out": out})
        elif r < 0.72:
            out = st.neutral(t)
            steps.append({"op": "neutral", "now": t, "out": out})
        elif r < 0.85:
            rows = [] if rng.random() < 0.2 else [[r9(t - rng.uniform(0.0, 0.6)), r6(rng.uniform(0.0, 1.0)),
                                                    r6(rng.uniform(0.02, 0.3))]]
            arrive = 0.16
            no_forward = rng.random() < 0.3
            out = st.update(_samples(rows), t, arrive, no_forward)
            steps.append({"op": "update", "history": rows, "now": t, "arrive_width": arrive,
                          "no_forward": no_forward, "out": out})
        elif r < 0.97:
            earlier = r9(t - rng.uniform(0.0, 6.0))
            later = r9(earlier + rng.uniform(-0.2, 3.0))
            steps.append({"op": "yaw_seen_between", "earlier": earlier, "later": later,
                          "out": st.yaw_seen_between(earlier, later)})
        else:
            st.reset()
            steps.append({"op": "reset", "out": None})
    return {"name": name, "cfg": cfg_name, "steps": steps}


DRIFT_STATE_FIELDS = ["active", "slide_rate", "yaw_rate", "calibrated", "disabled_reason", "disabled_by",
                      "mean_roll_near_end"]


def _drift_state(assist: DriftAssist) -> list:
    return [assist.active, assist.slide_rate, assist.yaw_rate, assist.calibrated, assist.disabled_reason,
            assist.disabled_by, assist.mean_roll_near_end()]


def _drift_sequence(name: str, seed: int, n_frames: int, *, overrides: Optional[Dict[str, float]] = None,
                    assumed_rate: float = 2.5, roll_sign: float = 1.0, roll_gain: float = 0.5, drift_accel: float = 0.25,
                    true_rate: float = 2.5, heading: float = 0.15, offset: float = 0.0, start_z: float = 2.5,
                    pauses: Sequence[int] = (), gaps: Sequence[int] = (), turns: Sequence[int] = (),
                    resets: Sequence[int] = (), duplicates: Sequence[int] = ()) -> dict:
    """A toy world around DriftAssist: a drone that drifts sideways, a roll that pushes it (the right way
    for roll_sign +1, the wrong way for -1), the default Steering for yaw and pitch, and the video one
    latency late. The physics is crude; the point is to drive every branch with plausible inputs."""
    rng = random.Random(seed)
    cfg = DriftAssistConfig(**(overrides or {}))
    assist = DriftAssist(cfg, assumed_yaw_rate=assumed_rate)
    steering = Steering()
    marker_m, k = 0.18, 0.5 / math.tan(math.radians(35.0))
    y, vy, z, h = offset, 0.0, start_z, heading
    roll = yaw = pitch = 0.0
    t = 2000.0
    latency = 0.45
    past: List[Tuple[float, float, float, float, float]] = []
    history: List[MarkerSample] = []
    prev_ts: Optional[float] = None
    steps: List[dict] = []
    for f in range(n_frames):
        dt = 1.0 / 15.0 + rng.uniform(-0.005, 0.005)
        if f in gaps:
            dt += 0.4
        if f in duplicates:
            dt = 0.0
        t = r9(t + dt)
        if dt > 0:
            vy += (drift_accel + roll_sign * roll_gain * roll - 0.6 * vy) * dt
            y += vy * dt
            z = max(0.4, z - 0.9 * pitch * dt)
            h += -true_rate * yaw * dt
        d_left, d_right = math.hypot(y + marker_m / 2, z), math.hypot(y - marker_m / 2, z)
        past.append((t, 0.5 + h - k * (y / z), marker_m * k / z, z / math.hypot(y, z),
                     (d_left - d_right) / (d_left + d_right)))
        seen = [p for p in past if p[0] <= t - latency] or past[:1]
        _t, cx, size, aspect, skew = seen[-1]
        cx = r6(cx + rng.gauss(0.0, 0.0008))
        size, aspect, skew = r6(size), r6(aspect + rng.gauss(0.0, 0.003)), r6(skew)
        if f in resets:
            assist.reset()
            steering.reset()
            prev_ts = None
            steps.append({"op": "reset", "out": None, "st": _drift_state(assist)})
        if f in pauses:
            out = assist.pause()
            prev_ts = None
            roll = out
            steps.append({"op": "pause", "out": out, "st": _drift_state(assist)})
            continue
        history = (history + [MarkerSample(ts=t, cx=cx, width=size)])[-2:]
        yaw, pitch = steering.update(history, t, 0.2)
        yaw_seen = 0.0 if prev_ts is None else r9(steering.yaw_seen_between(prev_ts, t))
        prev_ts = t
        flying_forward = pitch > 0.0 and f not in turns
        out = assist.update(t, cx, size, aspect, skew, yaw_seen, flying_forward)
        roll = out
        steps.append({"op": "update", "in": [t, cx, size, aspect, skew, yaw_seen, flying_forward], "out": out,
                      "st": _drift_state(assist)})
    return {"name": name, "cfg": dataclasses.asdict(cfg), "assumed_yaw_rate": assumed_rate, "steps": steps}


def build_steering() -> dict:
    rng = random.Random(11)
    functions = _steering_functions(rng)
    sequences = [
        _approach_sequence("approach_default", "default", 1, 300, true_rate=2.2, true_latency=0.45, arrive=0.16),
        _approach_sequence("approach_custom", "custom", 2, 220, true_rate=3.0, true_latency=0.5, arrive=0.2963),
        _shape_sequence("shape_search_reset", "default", 3, 260),
    ]
    drift = [
        # calibrates on the first turn, cancels a drift it has the authority for; a pause and a repeated frame time
        _drift_sequence("right_sign_steady_drift", 21, 200, heading=0.3, drift_accel=0.05, pauses=(150,),
                        duplicates=(60,)),
        # roll pushes the wrong way: the estimate runs to the bound and the slide check switches it off
        _drift_sequence("wrong_sign_switches_off_by_slide", 22, 200, roll_sign=-1.0, drift_accel=0.05, heading=0.12),
        # far off the axis and drifting further: the width/height check switches it off; after a reset it
        # qualifies again with a new reference and switches off again
        _drift_sequence("aspect_switches_off", 23, 200, overrides={"bound_dwell_s": 100.0}, drift_accel=0.05,
                        offset=0.6, start_z=1.5, heading=0.05, resets=(110,)),
        _drift_sequence("gaps_turns_and_reset", 24, 200, gaps=(40, 41, 120), turns=tuple(range(70, 80)),
                        resets=(160,), pauses=(100, 101), heading=0.3, drift_accel=-0.05),
        _drift_sequence("custom_config_uncalibrated", 25, 200, heading=0.0, drift_accel=0.04, assumed_rate=1.7,
                        overrides={"arm_window_s": 0.2, "gain": 0.2, "rate_max": 0.5, "roll_max": 0.12,
                                   "suggest_window_s": 1.5, "suggest_min_s": 0.5, "axis_min_size": 0.05,
                                   "axis_full_size": 0.07}),
        # switched off, then a reset (a new run) clears the switch-off and it qualifies again
        _drift_sequence("disabled_then_reset", 26, 200, roll_sign=-1.0, drift_accel=0.05, resets=(125,),
                        heading=0.3),
    ]
    _check_drift_coverage(drift)
    return {"configs": {name: dataclasses.asdict(cfg) for name, cfg in STEERING_CONFIGS.items()},
            "functions": functions, "sequences": sequences,
            "drift_state_fields": DRIFT_STATE_FIELDS, "drift_sequences": drift}


def _check_drift_coverage(sequences: List[dict]) -> None:
    """The traces are only worth something if they reach the interesting branches."""
    states = [step["st"] for seq in sequences for step in seq["steps"]]
    by_name = {seq["name"]: [step["st"] for step in seq["steps"]] for seq in sequences}
    assert any(s[0] for s in states), "never active"
    assert any(s[3] for s in states) and any(not s[3] for s in states), "calibration not covered"
    assert any(s[6] is not None for s in states), "no trim suggestion"
    assert not any(s[5] for s in by_name["right_sign_steady_drift"]), "the right sign switched itself off"
    assert any(s[5] == "slide" for s in by_name["wrong_sign_switches_off_by_slide"]), "slide check not reached"
    assert any(s[5] == "aspect" for s in by_name["aspect_switches_off"]), "aspect check not reached"
    after = by_name["disabled_then_reset"]
    first_off = next(i for i, s in enumerate(after) if s[4] is not None)
    assert any(s[0] for s in after[first_off:]), "not active again after the reset"


# ---------------------------------------------------------------------------------------------- #
# pose

POSE_FIELDS = ("lateral_m", "distance_m", "height_m", "yaw_deg", "rms_px")


def _pose_out(pose: Any) -> Any:
    return None if pose is None else {name: getattr(pose, name) for name in POSE_FIELDS}


def _world(size_m: float) -> np.ndarray:
    half = size_m / 2.0
    return np.array([[-half, half, 0.0], [half, half, 0.0], [half, -half, 0.0], [-half, -half, 0.0]])


def _focal(w: float, hfov: float) -> float:
    return (w / 2.0) / math.tan(math.radians(hfov) / 2.0)


def _corners(params: Sequence[float], size_m: float, w: int, h: int, hfov: float) -> List[List[float]]:
    uv = _project(np.asarray(params, dtype=np.float64), _world(size_m), _focal(w, hfov), w / 2.0, h / 2.0)
    return [[float(uv[i]), float(uv[4 + i])] for i in range(4)]


def _python_spread(corners: Any, w: Any, h: Any, size_m: float, hfov: float, iterations: int,
                   base: Any) -> Any:
    """How far Python's own result moves when the corner coordinates move by one unit in the last place
    (two nudges: all up, and alternately up and down; the larger change of each field).

    The fit amplifies rounding: its Jacobian is a finite difference with a 1e-6 step, and a far or
    degenerate pose sits in a long, flat valley where 12 iterations do not converge, so the last
    digits of the answer are not determined by the input. A port that rounds differently anywhere
    cannot agree more closely than this; the vitest suite holds it to the parity tolerance or a small
    multiple of this spread, whichever is larger."""
    if base is None:
        return None
    spread = {name: 0.0 for name in POSE_FIELDS}
    for alternate in (False, True):
        nudged = [[math.nextafter(v, -INF if alternate and (2 * i + j) % 2 else INF) for j, v in enumerate(p)]
                  for i, p in enumerate(corners)]
        pose = fit_sign_pose(nudged, w, h, size_m, hfov, iterations)
        for name in POSE_FIELDS:
            change = INF if pose is None else abs(getattr(pose, name) - base[name])
            spread[name] = max(spread[name], change)
    return spread


def _fit_case(corners: Any, w: Any, h: Any, size_m: float, hfov: float, iterations: int = 12,
              label: str = "") -> dict:
    case = {"label": label, "corners": corners, "frame_w": w, "frame_h": h, "marker_size_m": size_m,
            "hfov_deg": hfov, "iterations": iterations}
    out = _pose_out(fit_sign_pose(corners, w, h, size_m, hfov, iterations))
    case["out"] = out
    finite = all(math.isfinite(v) for corner in corners for v in corner) and w > 0 and h > 0
    case["spread"] = _python_spread(corners, w, h, size_m, hfov, iterations, out) if finite else None
    # True when the fit stopped by its own rule (a step under 1e-7, or no step improved) rather than
    # at the iteration cap: one more allowed iteration then changes nothing.
    case["stopped_by_rule"] = (None if out is None else
                               _pose_out(fit_sign_pose(corners, w, h, size_m, hfov, iterations + 1)) == out)
    return case


def build_pose() -> dict:
    rng = np.random.default_rng(20261112)   # only picks the inputs, which are recorded
    project_cases = []
    for i in range(36):
        z = float(rng.uniform(0.3, 5.0))
        params = [float(rng.uniform(-0.6, 0.6)), float(rng.uniform(-0.2, 0.2)), z, float(rng.uniform(-0.5, 0.5)),
                  float(rng.uniform(-0.2, 0.2)), float(rng.uniform(-0.1, 0.1))]
        if i == 33:
            params = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]            # camera in the marker plane: depth clamped
        if i == 34:
            params = [0.1, 0.05, 1.0, math.pi, 0.0, 0.0]       # facing away: the marker is behind the camera
        if i == 35:
            params = [0.0, 0.0, 1e-7, 0.0, 0.0, 0.0]           # 1e-7 m from the wall: depth clamped to 1e-6
        size_m = (0.18, 0.1, 0.25)[i % 3]
        w, h = ((640, 360), (1280, 720))[i % 2]
        hfov = (70.0, 60.0, 90.0)[i % 3]
        focal = _focal(w, hfov)
        world = _world(size_m)
        project_cases.append({"params": params, "world": world.tolist(), "focal": focal, "cx0": w / 2.0,
                              "cy0": h / 2.0,
                              "out": _project(np.asarray(params), world, focal, w / 2.0, h / 2.0).tolist()})

    fits = []
    n = 200
    for i in range(n):
        w, h = ((640, 360), (1280, 720))[i % 2]
        z = 0.3 * (5.0 / 0.3) ** (i / (n - 1))
        x = float(rng.uniform(-0.7, 0.7)) * min(1.0, 0.4 + z / 2.0)
        y = float(rng.uniform(-0.15, 0.15))
        yaw = -math.atan2(x, z) + math.radians(float(rng.uniform(-18.0, 18.0)))
        pitch = math.atan2(y, z) + math.radians(float(rng.uniform(-8.0, 8.0)))
        roll = math.radians(float(rng.uniform(-4.0, 4.0)))
        size_m = 0.18 if i % 7 else (0.1, 0.25)[(i // 7) % 2]
        hfov = 70.0 if i % 10 else (60.0, 90.0)[(i // 10) % 2]
        iterations = 12 if i % 17 else (1, 3, 30)[(i // 17) % 3]
        corners = _corners([x, y, z, yaw, pitch, roll], size_m, w, h, hfov)
        noise = (0.0, 0.3, 1.0)[i % 3] * (w / 640.0)
        if noise > 0:
            corners = [[round(u + float(rng.normal(0.0, noise)), 4), round(v + float(rng.normal(0.0, noise)), 4)]
                       for u, v in corners]
        fits.append(_fit_case(corners, w, h, size_m, hfov, iterations, f"pose {i}"))

    degenerate = [
        _fit_case([[300.0, 170.0], [302.0, 170.0], [302.0, 172.0], [300.0, 172.0]], 640, 360, 0.18, 70.0,
                  label="tiny: edges under 4 px"),
        _fit_case([[300.0, 170.0], [304.0, 170.0], [304.0, 172.0], [300.0, 172.0]], 640, 360, 0.18, 70.0,
                  label="exactly 4 px edge"),
        _fit_case([[320.0, 180.0]] * 4, 640, 360, 0.18, 70.0, label="all corners at one point"),
        _fit_case([[100.0, 100.0], [200.0, 100.0], [300.0, 100.0], [400.0, 100.0]], 640, 360, 0.18, 70.0,
                  label="collinear, horizontal"),
        _fit_case([[100.0, 50.0], [150.0, 100.0], [200.0, 150.0], [250.0, 200.0]], 640, 360, 0.18, 70.0,
                  label="collinear, diagonal"),
        _fit_case([[100.0, 100.0], [200.0, 100.0], [200.0, 100.0], [100.0, 100.0]], 640, 360, 0.18, 70.0,
                  label="flat: two pairs of equal corners"),
        _fit_case([[260.0, 120.0], [380.0, 240.0], [380.0, 120.0], [260.0, 240.0]], 640, 360, 0.18, 70.0,
                  label="bow tie (corner order wrong)"),
        _fit_case([[260.0, 120.0], [260.0, 240.0], [380.0, 240.0], [380.0, 120.0]], 640, 360, 0.18, 70.0,
                  label="mirrored (counter-clockwise)"),
        _fit_case(_corners([0.1, 0.05, 1.0, math.pi, 0.0, 0.0], 0.18, 640, 360, 70.0), 640, 360, 0.18, 70.0,
                  label="marker behind the camera"),
        _fit_case(_corners([0.3, 0.0, 0.8, math.radians(150.0), 0.0, 0.0], 0.18, 640, 360, 70.0), 640, 360, 0.18,
                  70.0, label="marker behind the camera, turned"),
        _fit_case(_corners([0.0, 0.0, 0.1, 0.0, 0.0, 0.0], 0.18, 640, 360, 70.0), 640, 360, 0.18, 70.0,
                  label="very close: corners far outside the frame"),
        _fit_case(_corners([0.05, 0.0, 0.8, 0.0, 0.0, 0.0], 0.18, 1280, 720, 70.0), 1280, 720, 0.18, 70.0, 0,
                  label="no iterations: the initial guess"),
        _fit_case(_corners([0.4, 0.1, 1.5, -0.2, 0.05, 0.02], 0.18, 640, 360, 150.0), 640, 360, 0.18, 150.0,
                  label="150 degree lens"),
        _fit_case(_corners([0.1, 0.0, 3.0, -0.03, 0.0, 0.0], 0.18, 640, 360, 30.0), 640, 360, 0.18, 30.0,
                  label="30 degree lens"),
        _fit_case([[NAN, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], 640, 360, 0.18, 70.0, label="NaN corner"),
        _fit_case([[INF, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]], 640, 360, 0.18, 70.0, label="infinite corner"),
        _fit_case(_corners([0.0, 0.0, 1.0, 0.0, 0.0, 0.0], 0.18, 640, 360, 70.0), 0, 360, 0.18, 70.0,
                  label="frame width 0"),
        _fit_case(_corners([0.0, 0.0, 1.0, 0.0, 0.0, 0.0], 0.18, 640, 360, 70.0), 640, -1, 0.18, 70.0,
                  label="negative frame height"),
        _fit_case([[1e6, 1e6], [1.1e6, 1e6], [1.1e6, 1.1e6], [1e6, 1.1e6]], 640, 360, 0.18, 70.0,
                  label="huge pixel coordinates"),
        _fit_case(_corners([0.0, 0.0, 1.0, 0.0, 0.0, 0.0], 0.18, 640, 360, 70.0), 640, 360, 0.0, 70.0,
                  label="marker size 0"),
        _fit_case([[320.0, 180.0], [420.0, 180.0], [420.0, 280.0], [320.0, 280.0]], 640, 360, 0.18, 70.0,
                  label="square from the principal point"),
        _fit_case(_corners([0.0, 0.0, 1.0, 0.0, 0.0, 0.0], 0.18, 640, 360, 70.0), 640, 360, 0.18, 70.0,
                  label="exactly head-on, centred"),
        _fit_case(_corners([0.0, 0.0, 6.0, 0.0, 0.0, 0.0], 0.18, 640, 360, 70.0), 640, 360, 0.18, 70.0, 50,
                  label="far, many iterations"),
    ]
    return {"fields": list(POSE_FIELDS), "project": project_cases, "fit": fits, "degenerate": degenerate}


# ---------------------------------------------------------------------------------------------- #
# mixer

SNAPSHOT_FIELDS = ["manual_active", "max_stick", "estop_active", "trim_roll", "trim_pitch", "source", "sent",
                   "estop_confirmed", "sticks_blocked"]


def _snapshot(snapshot: Any) -> list:
    return [getattr(snapshot, name) for name in SNAPSHOT_FIELDS]


class _LogCapture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: List[List[str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append([record.levelname.lower(), record.getMessage()])


def _script_link_class():
    from tests.harness import RecordingLink   # imported here: the other groups do not need the harness

    class ScriptLink(RecordingLink):
        """RecordingLink plus `toggle_ok`: when set, what takeoff_land_toggle() returns regardless of
        `control` (a socket that drops between the control_up() check and the send)."""

        def __init__(self) -> None:
            super().__init__()
            self.toggle_ok: Optional[bool] = None

        def takeoff_land_toggle(self) -> bool:
            if self.toggle_ok is None:
                return super().takeoff_land_toggle()
            self.toggles += 1
            return self.toggle_ok

    return ScriptLink


def _apply_mixer_op(op: dict, mixer: ControlMixer, link: Any, clock: Any) -> Any:
    """One scripted step. `now` is an explicit time, `now_rel` one relative to the fake clock; neither
    means the mixer reads its clock."""
    kind, now = op["op"], op.get("now")
    if "now_rel" in op:
        now = clock.t + op["now_rel"]
    try:
        if kind == "advance":
            clock.advance(op["dt"])
        elif kind == "frame":
            link.new_frame(clock.t)
        elif kind == "no_frame":
            link.frame = None
        elif kind == "link":
            for key in ("control", "mode", "toggle_ok"):
                if key in op:
                    setattr(link, key, op[key])
        elif kind == "tick":
            if op.get("dt"):
                clock.advance(op["dt"])
            if op.get("frame"):
                link.new_frame(clock.t)
            return list(mixer.tick(now))
        elif kind == "pilot_axes":
            mixer.pilot_axes(*op["v"], now=now)
        elif kind == "pilot_disconnect":
            mixer.pilot_disconnect()
        elif kind == "pilot_toggle":
            result = mixer.pilot_toggle(now)
            return [result.ok, result.message, result.code]
        elif kind == "mission_toggle":
            return mixer.mission_toggle(now, landing=op.get("landing", True))
        elif kind == "pilot_estop":
            return mixer.pilot_estop(now)
        elif kind == "estop_reset":
            mixer.estop_reset()
        elif kind == "calibrate":
            return list(mixer.calibrate())
        elif kind == "set_max_stick":
            return mixer.set_max_stick(op["value"])
        elif kind == "set_trim":
            return list(mixer.set_trim(op["roll"], op["pitch"]))
        elif kind == "trim":
            return list(mixer.trim())
        elif kind == "mission_command":
            mixer.mission_command(op["yaw"], op["pitch"], now, roll=op.get("roll", 0.0))
        elif kind == "clear_mission_command":
            mixer.clear_mission_command()
        elif kind == "seconds_since_toggle":
            return mixer.seconds_since_toggle(now)
        elif kind == "estop_active":
            return mixer.estop_active
        elif kind == "snapshot":
            return _snapshot(mixer.snapshot(now))
        else:
            raise KeyError(kind)
    except ValueError as exc:
        return {"error": "ValueError", "message": str(exc)}
    return None


def _run_mixer_scenario(name: str, init: dict, ops: List[dict]) -> dict:
    from tests.harness import FakeClock

    clock = FakeClock(init.get("clock", 1000.0))
    link = _script_link_class()()
    link.mode = init.get("mode", "sim")
    link.control = init.get("control", True)
    if init.get("frame", True):
        link.new_frame(clock.t)
    events: List[list] = []
    holder: Dict[str, ControlMixer] = {}
    callback_kind = init.get("callback", "record")

    def callback(kind: str) -> None:
        mixer = holder["mixer"]
        events.append([kind, link.toggles, link.estops, len(link.axes), mixer.estop_active])
        if callback_kind == "raise":
            raise RuntimeError("callback failed on purpose")
        if callback_kind == "reenter":
            if kind == "toggle":
                mixer.mission_command(0.05, 0.1)
            elif kind == "estop":
                mixer.estop_reset()
            elif kind == "axes":
                mixer.clear_mission_command()

    mixer = ControlMixer(link, rate_hz=init.get("rate_hz", 20.0), clock=clock,
                         trim=tuple(init.get("trim", (0.0, 0.0))), max_stick=init.get("max_stick", 0.5),
                         on_pilot_input=None if callback_kind == "none" else callback)
    holder["mixer"] = mixer
    logger = logging.getLogger("medhop.mixer")
    capture = _LogCapture()
    saved = (logger.level, logger.propagate)
    logger.addHandler(capture)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    steps = []
    try:
        for op in ops:
            n_axes, n_results, n_events, n_logs = len(link.axes), len(link.estop_results), len(events), len(capture.records)
            step = dict(op)
            step["out"] = _apply_mixer_op(op, mixer, link, clock)
            step["snap"] = _snapshot(mixer.snapshot())
            step["link"] = [len(link.axes), link.toggles, link.estops, link.calibrations]
            if len(link.axes) > n_axes:
                step["axes"] = [list(a) for a in link.axes[n_axes:]]
            if len(link.estop_results) > n_results:
                step["estop_results"] = link.estop_results[n_results:]
            if len(events) > n_events:
                step["events"] = events[n_events:]
            if len(capture.records) > n_logs:
                step["logs"] = capture.records[n_logs:]
            steps.append(step)
    finally:
        logger.removeHandler(capture)
        logger.setLevel(saved[0])
        logger.propagate = saved[1]
    return {"name": name, "init": init, "steps": steps}


def T(dt: float = 0.05, frame: bool = True, now: Optional[float] = None) -> dict:
    op: Dict[str, Any] = {"op": "tick", "dt": dt, "frame": frame}
    if now is not None:
        op["now"] = now
    return op


def O(kind: str, **kw: Any) -> dict:
    return {"op": kind, **kw}


def _scripted_mixer_scenarios() -> List[Tuple[str, dict, List[dict]]]:
    out = []
    ops = [T(), O("mission_command", yaw=0.12, pitch=0.22), T(), O("mission_command", yaw=0.12, pitch=0.22, roll=-0.08),
           T()]
    for asked in (0.5, -1.0, 0.15, NAN, INF):
        ops += [O("mission_command", yaw=0.0, pitch=0.1, roll=asked), T()]
    ops += [O("mission_command", yaw=0.12, pitch=0.22), T(0.45), T(0.10),
            O("mission_command", yaw=0.12, pitch=0.22), O("pilot_axes", v=[0.0, 0.0, -1.0, 0.0])]
    ops += [x for _ in range(10) for x in (O("pilot_axes", v=[0.0, 0.0, -1.0, 0.0]), T())]
    ops += [O("set_max_stick", value=0.3)] + [x for _ in range(10) for x in (O("pilot_axes", v=[1.0, -1.0, 0.5, 0.2]), T())]
    ops += [O("pilot_axes", v=[0.0, 1.0, 0.0, 0.0]), T(0.05), T(0.30), T(0.10), O("pilot_axes", v=[0.0, 0.0, 0.0, 0.0]),
            O("mission_command", yaw=0.1, pitch=0.2), T(), O("mission_command", yaw=0.12, pitch=0.22),
            O("pilot_axes", v=[0.0, 0.5, 0.0, 0.0]), T(0.5), T(), O("pilot_axes", v=[2.0, -3.0, 1e-7, -1e-6]), T(),
            O("pilot_axes", v=[0.0, 0.0, 1e-6, 0.0]), T(), O("pilot_axes", v=[0.0, 0.0, 1.1e-6, 0.0]), T()]
    out.append(("priority", {}, ops))

    ops = [O("set_max_stick", value=1.0), T()]
    ops += [x for _ in range(6) for x in (O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0]), T(0.05))]
    ops += [O("pilot_axes", v=[0.0, 0.0, 0.0, 0.0]), T(0.05), T(0.05)]
    ops += [x for _ in range(6) for x in (O("pilot_axes", v=[1.0, 1.0, 1.0, 1.0]), T(0.05))]
    ops += [O("pilot_disconnect"), T(0.05), O("snapshot")]
    ops += [x for _ in range(4) for x in (O("pilot_axes", v=[0.3, -0.7, 0.9, -0.2]), T(0.02))]
    ops += [O("pilot_axes", v=[-0.3, 0.7, -0.9, 0.2]), T(0.7), O("pilot_axes", v=[-0.3, 0.7, -0.9, 0.2]), T(0.033)]
    out.append(("ramp", {"max_stick": 0.8}, ops))

    ops = [O("set_trim", roll=0.05, pitch=-0.02), T(), O("mission_command", yaw=0.1, pitch=0.2), T(),
           O("set_max_stick", value=1.0)]
    ops += [x for _ in range(8) for x in (O("pilot_axes", v=[0.0, 0.0, 1.0, -1.0]), T())]
    ops += [O("set_trim", roll=0.9, pitch=-0.9), O("trim")]
    ops += [x for _ in range(8) for x in (O("pilot_axes", v=[0.0, 0.0, -1.0, 1.0]), T())]
    ops += [O("set_trim", roll=NAN, pitch=0.0), O("set_trim", roll=0.0, pitch=INF), O("pilot_axes", v=[0.0, INF, 0.0, 0.0]),
            O("set_max_stick", value=0.1), O("set_max_stick", value=1.5), O("set_max_stick", value=NAN),
            O("set_max_stick", value=0.2), O("trim"), O("set_trim", roll=-0.0, pitch=0.3), T(0.6, False)]
    out.append(("trim_and_bad_values", {"trim": [0.4, -0.05], "max_stick": 3.0}, ops))

    ops = [x for _ in range(9) for x in (O("mission_command", yaw=0.12, pitch=0.22), T(0.05, False))]
    ops += [x for _ in range(2) for x in (O("mission_command", yaw=0.12, pitch=0.22), T(0.05, False))]
    ops += [O("set_trim", roll=0.04, pitch=0.01), O("mission_command", yaw=0.12, pitch=0.22), T(0.6, False),
            O("no_frame"), O("mission_command", yaw=0.12, pitch=0.22), T(0.05, False), O("set_max_stick", value=1.0)]
    ops += [x for _ in range(20) for x in (O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0]), T(0.05, False))]
    ops += [O("frame"), O("mission_command", yaw=-0.3, pitch=0.05, roll=0.02), T(0.5, False), T(0.0001, False)]
    out.append(("video_failsafe", {}, ops))

    ops = [O("set_trim", roll=0.05, pitch=0.05), O("mission_command", yaw=0.12, pitch=0.22), O("pilot_estop")]
    ops += [x for _ in range(12) for x in (O("mission_command", yaw=0.12, pitch=0.22),
                                           O("pilot_axes", v=[1.0, 1.0, 1.0, 1.0]), T())]
    ops += [O("estop_reset"), T(), O("pilot_estop"), T(), O("pilot_estop"), T(0.3), O("pilot_estop"),
            O("estop_reset"), O("estop_reset")]
    ops += [O("pilot_estop")] + [T() for _ in range(6)] + [O("link", control=False)] + [T() for _ in range(10)]
    ops += [O("link", control=True)] + [T() for _ in range(5)] + [O("estop_reset"), O("calibrate"), T()]
    ops += [O("link", control=False), O("pilot_estop")] + [T() for _ in range(3)] + [O("link", control=True)]
    ops += [T() for _ in range(11)] + [O("pilot_estop"), T(0.2), O("estop_reset"), O("snapshot"), T()]
    out.append(("estop", {}, ops))

    ops = [O("pilot_toggle"), O("advance", dt=0.5), O("pilot_toggle"), O("advance", dt=0.6), O("pilot_toggle"),
           O("advance", dt=0.5), O("mission_toggle"), O("seconds_since_toggle"), O("advance", dt=5.0),
           O("mission_command", yaw=0.0, pitch=0.0), O("advance", dt=0.5), O("mission_toggle"),
           O("advance", dt=1.5), O("pilot_toggle"), O("advance", dt=2.4), O("pilot_toggle"), O("advance", dt=0.2),
           O("pilot_toggle"), O("seconds_since_toggle"), O("advance", dt=5.0), O("mission_command", yaw=0.0, pitch=0.0),
           O("mission_toggle", landing=False), O("advance", dt=1.1), O("pilot_toggle"), O("advance", dt=5.0),
           O("link", control=False), O("pilot_toggle"), O("mission_command", yaw=0.0, pitch=0.0),
           O("mission_toggle"), O("link", control=True), O("advance", dt=1.1), O("pilot_toggle"),
           O("advance", dt=5.0), O("mission_command", yaw=0.0, pitch=0.0), O("link", toggle_ok=False),
           O("mission_toggle"), O("advance", dt=1.2), O("mission_command", yaw=0.0, pitch=0.0), O("mission_toggle"),
           O("link", toggle_ok=None), O("advance", dt=1.2), O("pilot_toggle"), O("link", toggle_ok=False),
           O("advance", dt=4.5), O("pilot_toggle"), O("link", toggle_ok=None), O("pilot_estop"), O("pilot_toggle"),
           O("mission_toggle"), O("calibrate"), O("estop_reset"), O("advance", dt=5.0), O("pilot_toggle"),
           O("seconds_since_toggle", now=0.0)]
    ops += [O("advance", dt=10.0), O("pilot_axes", v=[0.0, 0.3, 0.0, 0.0], now_rel=0.0),
            O("mission_command", yaw=0.0, pitch=0.0, now_rel=0.1), O("mission_toggle", now_rel=0.2),
            O("mission_command", yaw=0.0, pitch=0.0, now_rel=0.45), O("mission_toggle", now_rel=0.5),
            O("advance", dt=5.0), O("pilot_toggle", now_rel=0.0), O("mission_command", yaw=0.0, pitch=0.0, now_rel=0.1),
            O("mission_toggle", now_rel=0.2), O("advance", dt=5.0), O("pilot_estop", now_rel=0.0), O("estop_reset"),
            O("mission_command", yaw=0.0, pitch=0.0, now_rel=0.1), O("mission_toggle", now_rel=0.2),
            O("pilot_axes", v=[0.0, 0.3, 0.0, 0.0]), O("advance", dt=0.5), O("mission_command", yaw=0.0, pitch=0.0),
            O("pilot_axes", v=[0.0, 0.0, 0.0, 0.0]), O("mission_toggle"), O("seconds_since_toggle", now_rel=-1.0)]
    out.append(("toggles_and_guards", {}, ops))

    ops = [O("set_max_stick", value=1.0), O("set_trim", roll=0.04, pitch=0.01)]
    ops += [x for _ in range(10) for x in (O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0]), T(0.05, True))]
    ops += [x for _ in range(61) for x in (O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0]), T(0.05, False))]
    ops += [O("pilot_toggle"), O("pilot_estop"), O("estop_reset"), O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0]),
            T(0.05, True), O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0]), T(0.05, True), O("no_frame"),
            O("mission_command", yaw=0.1, pitch=0.1), T(0.05, False), O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0]),
            T(0.05, False), O("link", mode="sim"), T(0.05, False), O("link", mode="real"), T(0.05, False)]
    out.append(("real_mode_sticks_blocked", {"mode": "real"}, ops))

    ops = [O("pilot_axes", v=[0.0, 0.0, 0.3, 0.0]), T(), O("pilot_toggle"), O("pilot_estop"), T(), O("estop_reset"),
           T(), O("pilot_axes", v=[0.0, 0.0, 0.0, 0.0])]
    out.append(("callback_raises", {"callback": "raise"}, ops))

    ops = [O("mission_command", yaw=0.2, pitch=0.1), O("pilot_axes", v=[0.0, 0.0, 0.3, 0.0]), T(), O("advance", dt=2.0),
           O("pilot_toggle"), T(), O("advance", dt=0.5), O("mission_toggle"), O("pilot_estop"), T(), T(),
           O("advance", dt=2.0), O("mission_toggle"), O("pilot_toggle")]
    out.append(("callback_reenters", {"callback": "reenter"}, ops))

    ops = [O("pilot_axes", v=[0.0, 0.0, 0.3, 0.0]), T(), O("pilot_toggle"), O("pilot_estop"), T(), O("estop_reset"), T()]
    out.append(("no_callback", {"callback": "none", "frame": False}, ops))

    ops = []
    for yaw, pitch in ((NAN, 0.2), (0.1, INF), (-INF, NAN)):
        ops += [O("mission_command", yaw=0.12, pitch=0.22), T(), O("mission_command", yaw=yaw, pitch=pitch), T()]
    ops += [O("mission_command", yaw=3.0, pitch=-2.0, roll=-0.0), T(), O("mission_command", yaw=-0.0, pitch=0.0), T()]
    out.append(("non_finite_mission", {}, ops))

    ops = [T(now=1000.5), T(now=1000.2), T(now=1001.4), O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0], now=999.0), T(0.01),
           O("pilot_axes", v=[0.0, 0.0, 1.0, 0.0], now=1001.45), T(now=1001.5), O("snapshot", now=1001.9),
           O("snapshot", now=1001.85), O("mission_command", yaw=0.1, pitch=0.1, now=1002.0), T(now=1001.6),
           T(now=1002.49), T(now=1002.5), O("seconds_since_toggle", now=5.0), O("pilot_toggle", now=0.0),
           O("seconds_since_toggle"), O("pilot_toggle", now=0.5), O("pilot_toggle", now=1.5), O("estop_active")]
    out.append(("explicit_times", {"clock": 1000.0, "rate_hz": 50.0}, ops))
    return out


def _fuzz_mixer_ops(seed: int, n: int, real: bool) -> List[dict]:
    """Random operations; on the real drone with long video outages so the sticks get blocked."""
    rng = random.Random(seed)
    outage = False
    ops: List[dict] = []

    def axis() -> float:
        return rng.choice((0.0, 0.0, r6(rng.uniform(-1.0, 1.0)), r6(rng.uniform(-1.5, 1.5)), 1.0, -1.0))

    for _ in range(n):
        if rng.random() < (0.05 if real else 0.02):
            outage = not outage
        r = rng.random()
        if r < 0.40:
            dt = rng.choice((0.05, 0.05, 0.05, 0.05, 0.02, 0.1, 0.3, 0.6)) + round(rng.uniform(-0.003, 0.003), 4)
            ops.append(T(round(dt, 4), (not outage) and rng.random() < 0.85))
        elif r < 0.55:
            v = [axis(), axis(), axis(), axis()]
            op = O("pilot_axes", v=v)
            if rng.random() < 0.1:
                op["now_rel"] = round(rng.uniform(-0.5, 0.5), 4)
            ops.append(op)
        elif r < 0.67:
            op = O("mission_command", yaw=r6(rng.uniform(-1.2, 1.2)), pitch=r6(rng.uniform(-0.5, 0.5)))
            if rng.random() < 0.5:
                op["roll"] = rng.choice((r6(rng.uniform(-0.3, 0.3)), NAN, 0.0))
            if rng.random() < 0.03:
                op["yaw"] = NAN
            ops.append(op)
        elif r < 0.71:
            ops.append(O("pilot_toggle"))
        elif r < 0.75:
            ops.append(O("mission_toggle", landing=rng.random() < 0.7))
        elif r < 0.775:
            ops.append(O("pilot_estop"))
        elif r < 0.81:
            ops.append(O("estop_reset"))
        elif r < 0.83:
            ops.append(O("link", control=rng.random() < 0.6))
        elif r < 0.85:
            ops.append(O("set_trim", roll=r6(rng.uniform(-0.4, 0.4)), pitch=r6(rng.uniform(-0.4, 0.4))))
        elif r < 0.87:
            ops.append(O("set_max_stick", value=rng.choice((0.2, 0.5, 1.0, r6(rng.uniform(0.1, 1.1))))))
        elif r < 0.89:
            ops.append(O("pilot_disconnect"))
        elif r < 0.91:
            ops.append(O("clear_mission_command"))
        elif r < 0.94:
            ops.append(O("advance", dt=round(rng.uniform(0.0, 1.5), 4)))
        elif r < 0.96:
            ops.append(O("seconds_since_toggle"))
        elif r < 0.97:
            ops.append(O("calibrate"))
        elif r < 0.98:
            ops.append(O("no_frame"))
        else:
            ops.append(O("snapshot", now_rel=round(rng.uniform(-0.6, 0.6), 4)))
    return ops


def build_mixer() -> dict:
    scenarios = [_run_mixer_scenario(name, init, ops) for name, init, ops in _scripted_mixer_scenarios()]
    scenarios.append(_run_mixer_scenario("fuzz_sim", {}, _fuzz_mixer_ops(31, 330, real=False)))
    scenarios.append(_run_mixer_scenario("fuzz_sim_raising_callback", {"callback": "raise", "trim": [0.02, -0.01]},
                                         _fuzz_mixer_ops(32, 200, real=False)))
    scenarios.append(_run_mixer_scenario("fuzz_real", {"mode": "real", "max_stick": 0.7},
                                         _fuzz_mixer_ops(33, 330, real=True)))
    return {"snapshot_fields": SNAPSHOT_FIELDS, "scenarios": scenarios}


# ---------------------------------------------------------------------------------------------- #
# avoid: mission/avoid.py, the distance estimates from a box and the state machine

def _avoid_configs() -> Dict[str, Any]:
    from medhop.mission.avoid import AvoidConfig
    return {
        "default": AvoidConfig(),
        "low": AvoidConfig(camera_height_m=0.3),        # sees the floor from 0.76 m: every distance placeable
        "ground": AvoidConfig(camera_height_m=0.04),    # the start blocker's camera on the ground
        "wide": AvoidConfig(hfov_deg=90.0, frame_aspect=4.0 / 3.0, lane_half_m=0.4, slow_distance_m=2.5,
                            hold_distance_m=1.2, back_distance_m=0.7, clear_confirm_s=0.5, blocked_timeout_s=6.0,
                            lat_kp=0.5, lat_ki=0.3, roll_max=0.1, roll_rise_per_s=2.0, match_fw=0.08,
                            person_height_m=1.8, edge_margin=0.01, horizon_margin=0.02),
    }


def _seen_row(s: Any) -> Any:
    return None if s is None else [s.kind, list(s.box), s.ts, s.distance_m, s.lateral_m, s.half_width_m, s.near_m,
                                   s.in_lane]


def _avoid_command_row(c: Any) -> list:
    return [c.state, c.pitch_cap, c.pitch, c.roll, c.freeze_yaw, c.blocked, c.reason]


def _avoid_box_at(distance: float, lateral: float, width: float, height: float, cfg: Any) -> Tuple[float, ...]:
    """tests/test_avoid.py box_at: an upright box standing on the floor `distance` metres ahead."""
    from medhop.mission.avoid import focal_fh, focal_fw
    f, fh = focal_fw(cfg), focal_fh(cfg)
    x1 = 0.5 + (lateral - width / 2.0) * f / distance
    x2 = 0.5 + (lateral + width / 2.0) * f / distance
    y2 = 0.5 + cfg.camera_height_m * fh / distance
    y1 = 0.5 - (height - cfg.camera_height_m) * fh / distance
    return tuple(max(0.0, min(1.0, v)) for v in (x1, y1, x2, y2))


def _avoid_functions(rng: random.Random) -> dict:
    from medhop.mission.avoid import (blind_distance_m, estimate, floor_distance_m, focal_fh, focal_fw, nearest,
                                      sign_lateral_m)
    configs = _avoid_configs()
    geometry = {name: {"focal_fw": focal_fw(cfg), "focal_fh": focal_fh(cfg), "blind_distance_m": blind_distance_m(cfg)}
                for name, cfg in configs.items()}
    floor = []
    for name, cfg in configs.items():
        for y2 in (0.0, 0.4, 0.5, 0.505, 0.51, 0.5100001, 0.51 + 1e-12, 0.52, 0.53, 0.6, 0.75, 0.9, 0.995, 0.996,
                   1.0, 1.2, -0.3, NAN, INF):
            floor.append([name, y2, floor_distance_m(y2, cfg)])
        for _ in range(10):
            y2 = r9(rng.uniform(0.45, 1.0))
            floor.append([name, y2, floor_distance_m(y2, cfg)])

    boxes: List[Tuple[str, Any, str]] = []
    for name, cfg in configs.items():
        for kind in ("person", "object"):
            for distance in (0.9, 2.6, 3.0, 12.0):
                for lateral in (0.0, 0.78, -0.8, 1.5):
                    for width, height in ((0.45, 1.7), (0.6, 0.9)):
                        boxes.append((kind, tuple(r9(v) for v in _avoid_box_at(distance, lateral, width, height, cfg)),
                                      name))
        edge = 1.0 - cfg.edge_margin
        specials = [
            (0.4, 0.2, 0.6, 0.45),                 # bottom above the horizon: no distance
            (0.4, 0.2, 0.6, 0.5),
            (0.4, cfg.edge_margin, 0.6, 0.8),      # top exactly at the margin: no person height
            (0.4, cfg.edge_margin + 1e-9, 0.6, 0.8),
            (0.4, 0.3, 0.6, edge),                 # bottom exactly at the cut-off
            (0.4, 0.3, 0.6, edge - 1e-9),
            (0.4, 0.6, 0.6, 0.6 + 5e-7),           # under 1e-6 tall
            (0.4, 0.6, 0.6, 0.6 + 2e-6),
            (0.6, 0.3, 0.4, 0.7),                  # x1 > x2
            (0.0, 0.0, 1.0, 1.0), (0.0, 0.2, 0.05, 0.62), (0.95, 0.2, 1.0, 0.62), (0.5, 0.2, 0.5, 0.62),
            (0.49, 0.3, 0.51, 0.62), (0.2, 0.1, 0.48, 0.7), (0.52, 0.1, 0.9, 0.7),
            (0.4, 0.2, 0.6, NAN), (NAN, 0.2, 0.6, 0.7), (0.4, 0.2, 0.6, 0.5 + cfg.horizon_margin),
        ]
        for box in specials:
            boxes.append(("person", box, name))
            boxes.append(("object", box, name))
        for _ in range(25):
            x1 = rng.uniform(-0.1, 0.9)
            y1 = rng.uniform(-0.1, 0.6)
            box = (r9(x1), r9(y1), r9(x1 + rng.uniform(0.0, 0.5)), r9(y1 + rng.uniform(0.0, 0.7)))
            boxes.append((rng.choice(("person", "object")), box, name))
    # [cfg, kind, box, [distance_m, lateral_m, half_width_m, near_m, in_lane]], all at ts AVOID_TS
    estimates = []
    for kind, box, name in boxes:
        s = estimate(kind, box, AVOID_TS, configs[name])
        estimates.append([name, kind, list(box), [s.distance_m, s.lateral_m, s.half_width_m, s.near_m, s.in_lane]])

    cfg = configs["default"]
    pool = [(kind, box) for kind, box, name in boxes if name == "default"]
    # [[kind, box], ...] estimated with the default config, and the index nearest() picked (None: empty)
    nearest_cases: List[list] = [[[], None]]

    def nearest_case(items: List[Tuple[str, Any]]) -> list:
        seen = [estimate(kind, box, AVOID_TS, cfg) for kind, box in items]
        best = nearest(seen)
        return [[[kind, list(box)] for kind, box in items], None if best is None else seen.index(best)]

    for _ in range(40):
        nearest_cases.append(nearest_case(rng.sample(pool, rng.randint(1, 6))))
    twin = tuple(r9(v) for v in _avoid_box_at(3.0, 0.0, 0.45, 1.7, cfg))
    nearest_cases.append(nearest_case([("person", twin), ("person", twin)]))         # a tie: the first
    close = [(kind, box) for kind, box in pool if estimate(kind, box, AVOID_TS, cfg).distance_m is None][:3]
    nearest_cases.append(nearest_case(close))

    lateral = []
    for name, c in configs.items():
        for cx in (0.0, 0.2, 0.45, 0.5, 0.55, 0.8, 1.0):
            for range_m in (0.4, 1.0, 3.5, 6.0):
                lateral.append([name, cx, range_m, sign_lateral_m(cx, range_m, c)])
    return {"ts": AVOID_TS, "geometry": geometry, "floor": floor, "estimate": estimates, "nearest": nearest_cases,
            "sign_lateral": lateral}


AVOID_TS = 1000.5
AVOID_STEP_FIELDS = ["now", "seen", "fresh", "sign", "out", "state", "holds", "no_progress_s", "blocked_reason",
                     "target", "snap", "events_n"]


def _run_avoider(name: str, cfg_name: str, steps: List[Tuple[float, list, bool, Any]]) -> dict:
    """Drive an Avoider through (now, [(kind, box)], fresh, sign) steps; record what every step returned
    and the state it left behind (one row per step, AVOID_STEP_FIELDS). Each step's obstacles are
    estimated with the sequence's config at ts = now, as the runner does; `target` is null, the index of
    this step's obstacle it is, or "same" (the previous step's target, kept)."""
    from medhop.mission.avoid import Avoider, estimate
    cfg = _avoid_configs()[cfg_name]
    avoider = Avoider(cfg)
    out = []
    previous = None
    for now, items, fresh, sign in steps:
        seen = [estimate(kind, box, now, cfg) for kind, box in items]
        command = avoider.update(now, seen, fresh, sign=sign)
        target = avoider.target
        if target is None:
            ref: Any = None
        elif any(target is s for s in seen):
            ref = next(i for i, s in enumerate(seen) if target is s)
        else:
            assert target is previous, "the target is always this step's obstacle or the previous target"
            ref = "same"
        previous = target
        snap = avoider.snapshot()
        out.append([now, [[kind, list(box)] for kind, box in items], fresh, None if sign is None else list(sign),
                    _avoid_command_row(command), avoider.state, avoider.holds, avoider.no_progress_s,
                    avoider.blocked_reason, ref, [snap["state"], snap["kind"], snap["distance_m"], snap["held_s"]],
                    len(avoider.events)])
    return {"name": name, "cfg": cfg_name, "steps": out, "events": avoider.events}


def _avoid_sequences(rng: random.Random) -> List[dict]:
    from medhop.mission.avoid import focal_fw
    configs = _avoid_configs()
    dt = 1.0 / 15.0

    def box(distance: float, lateral: float, width: float, height: float, cfg: Any) -> Tuple[float, ...]:
        return tuple(r9(v) for v in _avoid_box_at(distance, lateral, width, height, cfg))

    class Script:
        def __init__(self, cfg_name: str, t: float = 1000.0) -> None:
            self.cfg = configs[cfg_name]
            self.t = t
            self.steps: List[Tuple[float, list, bool, Any]] = []

        def seen(self, distance: float, lateral: float = 0.0, kind: str = "person", width: float = 0.45,
                 height: float = 1.7) -> Tuple[str, Any]:
            return kind, box(distance, lateral, width, height, self.cfg)

        def step(self, items: Callable[[], list] = list, step_dt: float = dt, fresh: bool = True, sign: Any = None,
                 n: int = 1) -> None:
            for _ in range(n):
                self.t += step_dt
                self.steps.append((self.t, items(), fresh, sign))

    out = []
    # tests/test_avoid.py: clear, slow, hold and back (the low camera places things at every distance)
    s = Script("low")
    s.step()
    s.step(lambda: [s.seen(3.5, kind="object", height=0.2)])
    s.step(lambda: [s.seen(2.5, lateral=1.5, kind="object", height=0.2)])
    s.step(lambda: [s.seen(2.9, kind="object", height=0.2)])
    s.step(lambda: [s.seen(1.7, kind="object", height=0.2)])
    s.step(lambda: [s.seen(0.85, kind="object", height=0.2)])
    s.step(lambda: [s.seen(0.7, kind="object", height=0.2)])
    s.step(n=20)
    s.step(lambda: [s.seen(2.9, kind="object", height=0.2)], n=3)
    s.step(lambda: [s.seen(2.9, kind="object", height=0.2)], fresh=False, n=3)
    s.step(n=3)
    out.append(_run_avoider("clear_slow_hold_and_back", "low", s.steps))

    # the hold: the clear confirmation starts again when something comes back; no evidence never clears
    s = Script("default")
    s.step(lambda: [s.seen(1.5)])
    s.step(lambda: [s.seen(4.0, lateral=2.0)], n=int(0.9 / dt))
    s.step(lambda: [s.seen(1.5)])
    s.step(n=int(0.95 / dt))
    s.step(fresh=False, n=5)
    s.step(n=int(1.2 / dt))
    s.step(lambda: [s.seen(1.5)])
    s.step(lambda: [s.seen(3.5, kind="object", height=0.9)], n=int(1.2 / dt))
    s.step(lambda: [s.seen(2.9, kind="object", height=0.9)])
    s.step(fresh=False, n=3)
    out.append(_run_avoider("clear_confirmation", "default", s.steps))

    # several holds add up; blocked after blocked_timeout_s held in total, and it stays blocked
    s = Script("wide")
    for _ in range(2):
        s.step(lambda: [s.seen(1.0)])
        s.step(lambda: [s.seen(1.0)], n=int(2.5 / dt))
        s.step(n=int(0.8 / dt))
    s.step(lambda: [s.seen(1.0)])
    s.step(lambda: [s.seen(1.0)], n=int(1.0 / dt) + 3)
    s.step(n=3)
    s.step(lambda: [s.seen(6.0, lateral=3.0)], n=3)
    out.append(_run_avoider("holds_add_up_then_blocked", "wide", s.steps))

    # the hold's sideways loop: on the obstacle's box (low camera), then on the sign (wins over the box)
    s = Script("low")
    s.step(lambda: [s.seen(2.8, kind="object", height=0.9)])
    s.step(lambda: [s.seen(1.5)])
    k = [0]

    def drifting() -> list:
        k[0] += 1
        return [("object", box(1.5, -0.02 * k[0], 0.45, 0.2, s.cfg))]

    s.step(drifting, n=int(3.0 / dt))
    s.step(lambda: [("object", box(1.5, 0.6, 0.45, 0.2, s.cfg))], n=4)     # another box
    s.step(lambda: [("person", box(1.5, 0.6, 0.45, 1.7, s.cfg))], n=4)     # another kind
    s.step(fresh=False, n=4)
    out.append(_run_avoider("hold_roll_on_the_box", "low", s.steps))

    s = Script("default")
    f = focal_fw(configs["default"])
    s.step(lambda: [s.seen(1.5)], sign=(0.5, 3.5))
    for k2 in range(int(3.0 / dt)):
        lat = -0.02 * k2
        s.step(lambda: [s.seen(2.0)], sign=(r9(0.5 + f * (-lat) / 3.5), 3.5))
    s.step(lambda: [s.seen(2.0)], n=10)
    s.step(lambda: [s.seen(2.0)], sign=(0.62, 3.4), n=3)
    out.append(_run_avoider("hold_roll_on_the_sign", "default", s.steps))

    # odd clocks: time going backwards, a long gap (dt clamped to 0.5) and repeated times
    s = Script("default")
    s.step(lambda: [s.seen(1.5)])
    for step_dt in (dt, -0.2, 0.0, 0.0, 2.0, 0.6, dt, -1.0, dt, 30.0, dt):
        s.step(lambda: [s.seen(1.5)], step_dt=step_dt)
    out.append(_run_avoider("odd_clocks", "default", s.steps))

    # flapping between clear and slow: more than 200 state changes (the event list is trimmed by 50)
    s = Script("default")
    for i in range(215):
        s.step((lambda: [s.seen(2.9, kind="object", height=0.9)]) if i % 2 else list)
    out.append(_run_avoider("event_trimming", "default", s.steps))

    # random sequences on every configuration
    # (busy and quiet stretches, so that it holds, clears and holds again before it is blocked)
    for seed, cfg_name, n in ((1, "default", 100), (2, "low", 100), (3, "wide", 140), (4, "ground", 24)):
        r = random.Random(1000 + seed)
        s = Script(cfg_name)
        lateral_drift = 0.0
        busy = False
        for i in range(n):
            if r.random() < 0.05:
                lateral_drift = r.uniform(-0.03, 0.03)
            if r.random() < 0.08:
                busy = not busy
            items = []
            for _ in range(r.choice((0, 1, 1, 2, 3) if busy else (0, 0, 0, 0, 0, 0, 1))):
                kind = r.choice(("person", "object"))
                distance = r.choice((r.uniform(0.6, 1.9), r.uniform(1.0, 3.2), r.uniform(2.5, 8.0)))
                lateral = r.choice((r.uniform(-0.6, 0.6), r.uniform(-3.0, 3.0), lateral_drift * (i % 40)))
                height = 1.7 if kind == "person" else r.choice((0.2, 0.9, 1.2))
                items.append((kind, box(distance, lateral, 0.45, height, s.cfg)))
            fresh = r.random() < 0.85
            sign = None if r.random() < 0.4 else (r6(r.uniform(0.2, 0.8)), r6(r.uniform(0.5, 6.0)))
            step_dt = r.choice((dt, dt, dt, dt, 0.02, 0.1, 0.6, -0.05)) + r.uniform(-0.002, 0.002)
            s.step(lambda: items, step_dt=round(step_dt, 6), fresh=fresh, sign=sign)
        out.append(_run_avoider(f"random_{cfg_name}", cfg_name, s.steps))
    return out


def build_avoid() -> dict:
    from medhop.mission.avoid import AVOID_STATES, NOT_MOVING_ON, AvoidConfig
    rng = random.Random(20261112)
    return {
        "config_defaults": dataclasses.asdict(AvoidConfig()),
        "configs": {name: dataclasses.asdict(cfg) for name, cfg in _avoid_configs().items()},
        "constants": {"AVOID_STATES": list(AVOID_STATES), "NOT_MOVING_ON": list(NOT_MOVING_ON)},
        "functions": _avoid_functions(rng),
        "sequences": _avoid_sequences(rng),
    }


# ---------------------------------------------------------------------------------------------- #
# simulator: drone/sim.py in stepped mode, drone/sim_actors.py, and the camera both use
#
# The simulator's own noise comes from numpy's generator, which the TypeScript port cannot replay, so
# every trace below runs with noise_velocity = noise_yaw_deg = 0. The generator is still consulted
# (three standard normals per physics step in flight), but each draw is multiplied by a zero amplitude
# and adding the resulting zero leaves the state as it was, so no draw reaches the trace. sensor_noise
# is 0 as well: only the picture uses it, and building its noise pool is most of a SimLink's start-up. The picture
# is patched out the way tests/test_sim_high_quality.py does it (SimLink._render_jpeg replaced on the
# instance), and the room renderer is not built at all (it only draws, and building it takes seconds);
# the camera matrix SimLink builds for both scenes is kept.

QUIET = {"noise_velocity": 0.0, "noise_yaw_deg": 0.0, "sensor_noise": 0.0}
ACTOR_FIELDS = ("kind", "x_m", "distance_m", "width_m", "depth_m", "height_m", "vx_m_s", "vd_m_s",
                "move_from_s", "move_until_s")
SIM_POSE_KEYS = ("x_m", "distance_m", "heading_deg", "altitude_m", "phase", "airborne")
STEP_S = 1.0 / 60.0


class _Clock:
    """FakeClock of tests/harness.py, kept here so the simulator groups do not import the mission runner."""

    def __init__(self, t: float = 1000.0) -> None:
        self.t = float(t)

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> float:
        self.t += dt
        return self.t


def _sim_config(profile: str, overrides: Dict[str, Any]) -> Any:
    from medhop.drone.sim import SimConfig
    kw = dict(overrides)
    if "actors" in kw:
        kw["actors"] = tuple(_actor_from_row(row) for row in kw["actors"])
    return SimConfig.high_quality(**kw) if profile == "high" else SimConfig(**kw)


def _actor_row(actor: Any) -> list:
    return [getattr(actor, name) for name in ACTOR_FIELDS]


def _actor_from_row(row: Sequence[Any]) -> Any:
    from medhop.drone.sim_actors import Actor
    return Actor(**dict(zip(ACTOR_FIELDS, row)))


def _snap_row(snap: dict) -> dict:
    return {"x": snap["x"], "z": snap["z"], "heading": snap["heading"], "cam_y": snap["cam_y"],
            "marker_hidden": snap["marker_hidden"], "actors": [_actor_row(a) for a in snap.get("actors") or ()]}


def _snap_list(snap: dict) -> list:
    """A snapshot in short form: x, z, heading, cam_y, marker_hidden, then [x_m, distance_m] of each actor
    (the other actor fields never change while it moves)."""
    return [snap["x"], snap["z"], snap["heading"], snap["cam_y"], snap["marker_hidden"],
            [[a.x_m, a.distance_m] for a in snap.get("actors") or ()]]


def _hover_snap(distance_m: float, x_m: float, heading_rad: float, cam_y: float = 1.04, actors: tuple = ()) -> dict:
    return {"x": float(x_m), "z": -abs(float(distance_m)), "heading": float(heading_rad), "cam_y": float(cam_y),
            "marker_hidden": False, "actors": actors}


class _TracedSim:
    """A SimLink on a fake clock whose picture is replaced by the index of the capture it shows.

    `captures` lists (capture time, snapshot) for every frame the simulator captured, in order. A
    released frame's `jpeg` names its capture (or is `jpeg` itself when one is given: the harness
    trace needs bytes it can decode)."""

    def __init__(self, config: Any, realtime: bool = False, jpeg: Optional[bytes] = None) -> None:
        from medhop.drone.sim import SimLink
        self.clock = _Clock()
        with mock.patch("medhop.drone.sim_scene.RoomRenderer", lambda *args, **kwargs: None):
            self.sim = SimLink(config, clock=self.clock, realtime=realtime)
        self.captures: List[Tuple[float, dict]] = []
        self.test_snaps: List[dict] = []
        self._index: Dict[int, int] = {}
        self._jpeg = jpeg
        take = self.sim._snapshot

        def snapshot() -> dict:
            snap = take()
            self._index[id(snap)] = len(self.captures)
            self.captures.append((self.sim._t, snap))
            return snap

        self.sim._snapshot = snapshot
        self.sim._render_jpeg = self._render

    def _render(self, snap: dict) -> bytes:
        index = self._index.get(id(snap))
        if index is None:                  # render_test_frame builds its own snapshot
            self.test_snaps.append(snap)
            return b""
        return self._jpeg if self._jpeg is not None else str(index).encode()


def _apply_sim_op(traced: _TracedSim, op: dict) -> Any:
    sim, clock = traced.sim, traced.clock
    kind = op["op"]
    if kind == "advance":
        sim.advance_to(clock.advance(op["dt"]))
    elif kind == "axes":
        sim.set_axes(*op["v"])
    elif kind == "toggle":
        return sim.takeoff_land_toggle()
    elif kind == "estop":
        return sim.emergency_stop()
    elif kind == "calibrate":
        sim.calibrate()
    elif kind == "stop":
        sim.stop()
    elif kind == "start":
        sim.start()
    elif kind == "set_pose":
        sim.set_pose(**op["kw"])
    elif kind == "force_auto_land":
        sim.force_auto_land(drop_battery=op.get("drop_battery", False), descent_m_s=op.get("descent_m_s"))
    elif kind == "freeze_video":
        sim.freeze_video(op["frozen"])
    elif kind == "drop_marker":
        sim.drop_marker(op["hidden"])
    elif kind == "set_drift":
        sim.set_drift(op["v"])
    elif kind == "set_battery_raw":
        sim.set_battery_raw(op["v"])
    elif kind == "set_scenario":
        try:
            sim.set_scenario(op["name"])
        except KeyError:
            return {"error": "KeyError"}
    elif kind == "set_actors":
        sim.set_actors([_actor_from_row(row) for row in op["actors"]], origin_now=op.get("origin_now", True))
    elif kind == "pose":
        return sim.pose()
    elif kind == "clearance":
        return sim.clearance_m()
    elif kind == "actors_now":
        return [_actor_row(a) for a in sim.actors_now()]
    elif kind == "status":
        return [a.as_status() for a in sim.actors_now()]
    elif kind == "scenario":
        return sim.scenario
    elif kind == "test_snapshot":
        sim.render_test_frame(*op["args"])
        return _snap_row(traced.test_snaps[-1])
    else:
        raise ValueError(f"unknown simulator op {kind!r}")
    return None


def _run_sim_scenario(name: str, profile: str, overrides: Dict[str, Any], ops: List[dict],
                      realtime: bool = False, snapshots: bool = True) -> dict:
    """Apply the ops one by one; after each, record the pose and whatever the simulator produced:
    new captures (time and the snapshot in short form; without `snapshots` only how many and the last
    time), the newest released frame when it is new (seq, release time, which capture it shows, its
    actor boxes) and the telemetry when it changed. An advance is written as {"dt": ...} alone."""
    config = {**QUIET, **overrides}
    traced = _TracedSim(_sim_config(profile, config), realtime=realtime)
    sim = traced.sim
    steps, n_captures, last_seq, last_tel = [], 0, None, None
    for op in ops:
        step = {"dt": op["dt"]} if op["op"] == "advance" else dict(op)
        out = _apply_sim_op(traced, op)
        if out is not None:
            step["out"] = out
        pose = sim.pose()
        step["pose"] = [pose[key] for key in SIM_POSE_KEYS]
        if len(traced.captures) > n_captures:
            new = traced.captures[n_captures:]
            step["captures"] = ([[t, *_snap_list(snap)] for t, snap in new] if snapshots
                                else {"count": len(new), "last": new[-1][0]})
            n_captures = len(traced.captures)
        frame = sim.latest_frame()
        if frame is not None and frame.seq != last_seq:
            last_seq = frame.seq
            step["frame"] = [frame.seq, frame.timestamp, int(frame.jpeg.decode()),
                             [[kind, list(box)] for kind, box in frame.obstacles]]
        tel = sim.telemetry()
        if tel is not None and tel != last_tel:
            last_tel = tel
            step["tel"] = [tel.fly_state_raw, tel.battery_raw, tel.flags_raw, tel.timestamp]
        steps.append(step)
    end = {"toggle_count": sim.toggle_count, "estop_count": sim.estop_count, "calibrate_count": sim.calibrate_count,
           "last_axes_sent": list(sim.last_axes_sent), "scenario": sim.scenario,
           "start_distance_m": sim.cfg.start_distance_m, "lateral_drift": sim.cfg.lateral_drift}
    return {"name": name, "profile": profile, "config": config, "realtime": realtime, "snapshots": snapshots,
            "steps": steps, "end": end}


def _adv(n: int = 1, dt: float = STEP_S) -> List[dict]:
    return [{"op": "advance", "dt": dt} for _ in range(n)]


def _op(kind: str, **kw: Any) -> dict:
    return {"op": kind, **kw}


def _axes(throttle: float, yaw: float, pitch: float, roll: float) -> dict:
    return {"op": "axes", "v": [throttle, yaw, pitch, roll]}


def _sim_scripts() -> List[Tuple[str, str, Dict[str, Any], List[dict], bool, bool]]:
    custom = [["object", 0.6, 1.2, 0.5, 0.3, 1.1, -0.3, 0.1, 0.5, 2.0]]
    ground_flight = (
        _adv(12) + [_op("toggle")] + _adv(110)                                  # takeoff: delay, then 1.5 s climb
        + [_axes(0.0, 0.3, 0.5, -0.2)] + _adv(40)
        + [_axes(0.4, -0.5, 0.2, 0.3)] + _adv(30)
        + [_axes(-0.6, 0.0, 0.0, 0.0)] + _adv(50)                               # down to the 0.3 m floor
        + [_axes(1.0, 0.0, 0.0, 0.0)] + _adv(35, 0.1)                           # up to the 1.9 m ceiling
        + [_op("set_drift", v=0.25), _axes(0.0, 0.0, 1.0, 0.0)] + _adv(60, 0.05)   # into the wall
        + [_op("set_pose", kw={"distance_m": 3.0, "x_m": 0.5, "heading_deg": -20.0})] + _adv(20)
        + [_axes(0.0, 0.0, -1.0, 1.0)] + _adv(60, 0.1)                          # back and sideways to the limits
        + [_axes(0.0, 0.0, 0.0, 0.0), _op("toggle"), _op("set_pose", kw={"airborne": True})] + _adv(12)
        + [_op("freeze_video", frozen=True)] + _adv(30) + [_op("freeze_video", frozen=False)] + _adv(10)
        + [_op("drop_marker", hidden=True)] + _adv(12) + [_op("drop_marker", hidden=False)] + _adv(3)
        + [_op("estop")] + _adv(12)
        + [_op("toggle")] + _adv(30) + [_op("toggle")] + _adv(60)                 # a takeoff turned into a landing
        + [_op("toggle")] + _adv(40, 0.05)
        + [_op("force_auto_land", drop_battery=True, descent_m_s=0.2)] + _adv(40, 0.05) + [_op("pose")]
        + [_op("set_battery_raw", v=77)] + _adv(70, 0.05)
        + [_op("force_auto_land")] + _adv(3)                                     # on the ground: nothing happens
        + [_op("toggle")] + _adv(20, 0.05) + [_op("toggle")] + _adv(30, 0.05)
        + [_op("set_pose", kw={"airborne": False, "distance_m": -1.7})] + _adv(3)
        + [_op("stop"), _op("calibrate"), _op("pose"), _op("test_snapshot", args=[2.0, 0.3, 10.0])]
        + _adv(10, 0.013) + _adv(5, 0.0333) + _adv(4, 0.25) + _adv(2, 0.0)
    )
    high_scenario = (
        _adv(4, 0.05) + [_op("set_scenario", name="crossing"), _op("scenario"), _op("pose")] + _adv(4, 0.05)
        + [_op("toggle")] + _adv(40, 0.05)
        + [_axes(0.0, 0.1, 0.15, 0.0)] + _adv(120, 0.05)                         # the person crosses at 7 s
        + [_op("clearance"), _op("actors_now"), _op("status")]
        + [_op("set_scenario", name="blocked")] + _adv(80, 0.05) + [_op("clearance"), _op("actors_now")]
        + [_op("set_scenario", name="no such scenario")]
        + [_op("set_actors", actors=custom, origin_now=False)] + _adv(10, 0.05) + [_op("actors_now")]
        + [_op("set_actors", actors=[]), _op("scenario"), _op("clearance")] + _adv(5, 0.05)
        + [_op("toggle")] + _adv(40, 0.05)
        + [_op("set_scenario", name="cart"), _op("pose"), _op("toggle")] + _adv(50, 0.05)
        + [_op("set_pose", kw={"heading_deg": 30.0, "x_m": -1.0})] + _adv(10, 0.05)
        + [_op("test_snapshot", args=[2.5, -0.2, -5.0])]
    )
    airborne_start = (
        [_op("scenario"), _op("actors_now")] + _adv(1) + [_op("actors_now"), _axes(0.0, -0.4, 0.3, 0.1)]
        + _adv(100) + [_op("clearance"), _op("status")]
    )
    gaps = (_adv(6, 0.05) + _adv(1, 2.0) + _adv(4, 0.05) + _adv(1, 0.3) + _adv(10, 0.05) + _adv(1, 0.6)
            + [_axes(0.0, 0.5, 0.5, 0.0)] + _adv(10, 0.05))
    custom_timing = (_adv(20, 0.013) + [_op("toggle")] + _adv(150, 0.013) + [_axes(0.2, 0.3, 0.4, -0.1)]
                     + _adv(60, 0.021) + [_op("toggle")] + _adv(50, 0.03))
    return [
        ("drone_ground_flight", "drone", {}, ground_flight, False, True),
        ("high_scenarios_reset_pose", "high", {"start_distance_m": 3.2, "reset_pose_on_takeoff": True},
         high_scenario, False, True),
        ("drone_airborne_start", "drone", {"start_airborne": True, "start_heading_deg": 25.0, "start_x_m": -0.4,
                                           "actors": custom}, airborne_start, False, True),
        ("drone_realtime_gaps", "drone", {"start_airborne": True}, gaps, True, True),
        ("high_battery_minute", "high", {"start_airborne": True}, _adv(125, 0.5) + [_op("pose")], False, False),
        ("drone_custom_timing", "drone", {"fps": 10.0, "command_delay_s": 0.2, "video_delay_s": 0.25,
                                          "takeoff_s": 1.0, "land_s": 0.8, "hover_height_m": 1.2,
                                          "marker_height_m": 1.1, "lateral_drift": -0.05},
         custom_timing, False, True),
    ]


def build_sim_physics() -> dict:
    scenarios = [_run_sim_scenario(name, profile, overrides, ops, realtime, snapshots)
                 for name, profile, overrides, ops, realtime, snapshots in _sim_scripts()]
    return {"pose_keys": list(SIM_POSE_KEYS), "actor_fields": list(ACTOR_FIELDS), "quiet": QUIET,
            "physics_step_s": STEP_S, "scenarios": scenarios}


# ---------------------------------------------------------------------------------------------- #
# sim_actors: the actors, their motion, the scenario table and the boxes frames carry

def _random_actor(rng: random.Random) -> Any:
    from medhop.drone.sim_actors import Actor
    return Actor(rng.choice(("person", "object")), x_m=r6(rng.uniform(-2.0, 2.0)),
                 distance_m=r6(rng.uniform(0.3, 4.0)), width_m=r6(rng.uniform(0.2, 1.0)),
                 depth_m=r6(rng.uniform(0.1, 0.6)), height_m=r6(rng.uniform(0.4, 2.0)))


def _random_snap(rng: random.Random, near: Optional[Sequence[Any]] = None) -> dict:
    """A camera anywhere in the room, or (with `near`) close to an actor so that its box crosses the near plane."""
    if near:
        a = rng.choice(list(near))
        x = r6(a.x_m + rng.uniform(-0.6, 0.6))
        z = r6(-(a.distance_m + rng.uniform(-0.3, 0.6)))
    else:
        x, z = r6(rng.uniform(-4.0, 4.0)), r6(rng.uniform(-7.5, -0.15))
    return _hover_snap(-z, x, r6(rng.uniform(-math.pi, math.pi)), r6(rng.uniform(0.04, 1.9)))


def build_sim_actors() -> dict:
    from medhop.drone import sim_actors as sa
    from medhop.drone.sim import SimLink

    rng = random.Random(4242)
    scenarios = [{"name": s.name, "start_distance_m": s.start_distance_m, "description": s.description,
                  "actors": [_actor_row(a) for a in s.actors]} for s in sa.SCENARIOS.values()]

    extra = [sa.Actor("object", 0.6, 1.2, 0.5, 0.3, 1.1, -0.3, 0.1, 0.5, 2.0),
             sa.Actor("person", -1.0, 2.0, vd_m_s=0.4, move_from_s=3.0, move_until_s=3.0),   # no window: never moves
             sa.Actor("person", 1.0, 2.0, vx_m_s=0.5, move_from_s=4.0, move_until_s=2.0)]    # until before from
    times: List[Optional[float]] = [None, -1.0, 0.0, 0.5, 2.0, 3.0, 4.0, 6.0, 6.5, 7.0, 9.0, 10.5, 13.0, 20.0]
    times += [round(0.37 * i, 2) for i in range(1, 40)]
    motion = []
    for s in sa.SCENARIOS.values():
        for i, actor in enumerate(s.actors):
            motion.append({"scenario": s.name, "index": i,
                           "at": [[t, actor.at(t).x_m, actor.at(t).distance_m] for t in times]})
    for i, actor in enumerate(extra):
        motion.append({"scenario": "extra", "index": i, "actor": _actor_row(actor),
                       "at": [[t, actor.at(t).x_m, actor.at(t).distance_m] for t in times]})

    status = [{"actor": _actor_row(a), "out": a.as_status()} for a in extra + [
        sa.Actor("person", 0.12345, 1.0005, 0.4445, 0.3335, 1.6665), sa.Actor("object", -2.0004999, 0.0015, 0.0025)]]

    errors = []
    for kw in ({"kind": "robot"}, {"width_m": 0.0}, {"depth_m": -0.1}, {"height_m": 0.0}, {"kind": "Person"}):
        try:
            sa.Actor(**kw)
            errors.append({"init": kw, "error": None})
        except ValueError as exc:
            errors.append({"init": kw, "error": str(exc)})

    footprint = []
    for _ in range(60):
        a = _random_actor(rng)
        x, d = r6(rng.uniform(-3, 3)), r6(rng.uniform(0, 5))
        footprint.append({"actor": _actor_row(a), "x_m": x, "distance_m": d, "out": sa.footprint_distance(a, x, d)})
    a0 = sa.SCENARIOS["cart"].actors[0]
    for x, d in ((a0.x_m, a0.distance_m), (a0.x_m + 0.3, a0.distance_m), (a0.x_m + 0.31, a0.distance_m + 0.21)):
        footprint.append({"actor": _actor_row(a0), "x_m": x, "distance_m": d, "out": sa.footprint_distance(a0, x, d)})

    corners = [{"actor": _actor_row(a), "out": sa.corners(a).tolist()} for a in extra[:2] + [a0]]

    # camera_points (the near-plane clip of a box) and actor_box, through SimLink's own camera and K
    cams = {}
    for w, h in ((640, 360), (1280, 720)):
        traced = _TracedSim(_sim_config("drone", {**QUIET, "width": w, "height": h}))
        cams[(w, h)] = traced.sim._K
    boxes = []
    for i in range(60):
        actors = [_random_actor(rng) for _ in range(rng.randint(1, 3))]
        snap = _random_snap(rng, near=actors if i % 3 == 0 else None)
        w, h = ((640, 360), (1280, 720))[i % 2]
        cam, rot = SimLink._camera(snap)
        case = {"snap": _snap_row({**snap, "actors": actors}), "width": w, "height": h, "actors": []}
        for a in actors:
            pts = sa.camera_points(a, cam, rot)
            case["actors"].append({"camera_points": pts.tolist(), "uv": sa.project(pts, cams[(w, h)]).tolist(),
                                   "box": sa.actor_box(a, cam, rot, cams[(w, h)], w, h)})
        case["boxes"] = [[kind, list(box)] for kind, box in sa.actor_boxes(actors, cam, rot, cams[(w, h)], w, h)]
        boxes.append(case)

    # the boxes frames carry, from the simulator itself, at scripted drone poses while the actors move
    frames = []
    for profile in ("drone", "high"):
        for name in sa.SCENARIO_NAMES:
            traced = _TracedSim(_sim_config(profile, {**QUIET, "start_airborne": True, "start_distance_m": 3.5}))
            sim = traced.sim
            sim.set_scenario(name)
            rows = []
            for k in range(28):
                t = 0.5 * k
                pose = [r6(3.6 - 1.2 * math.sin(0.21 * t)), r6(0.5 * math.sin(0.37 * t)), r6(25.0 * math.sin(0.5 * t))]
                sim.set_pose(distance_m=pose[0], x_m=pose[1], heading_deg=pose[2])
                sim.advance_to(traced.clock.advance(0.5))
                frame = sim.latest_frame()
                row: Dict[str, Any] = {"set_pose": pose, "seq": None if frame is None else frame.seq}
                if frame is not None:
                    _t, snap = traced.captures[int(frame.jpeg.decode())]
                    row["snap"] = _snap_list(snap)
                    row["obstacles"] = [[kind, list(box)] for kind, box in frame.obstacles]
                rows.append(row)
            frames.append({"profile": profile, "scenario": name, "rows": rows})

    return {"actor_fields": list(ACTOR_FIELDS), "kinds": list(sa.ACTOR_KINDS), "near_m": sa.NEAR_M,
            "scenario_names": list(sa.SCENARIO_NAMES), "scenarios": scenarios, "motion": motion,
            "status": status, "errors": errors, "footprint": footprint, "corners": corners, "boxes": boxes,
            "frames": frames}


# ---------------------------------------------------------------------------------------------- #
# projection: the pinhole camera of sim.py (and sim_scene.py, whose geometry is the same)

def _clip_near(points_cam: np.ndarray, near: float) -> List[np.ndarray]:
    """Reference for the TypeScript polygon clip (the Python renderer clips with warpPerspective
    masks, not polygons): Sutherland-Hodgman against the plane forward = near, keeping forward >= near,
    with the crossing points computed as camera_points in sim_actors.py computes them."""
    out: List[np.ndarray] = []
    n = len(points_cam)
    for i in range(n):
        a, b = points_cam[i], points_cam[(i + 1) % n]
        a_in, b_in = a[2] >= near, b[2] >= near
        if a_in:
            out.append(a)
        if a_in != b_in:
            t = (near - a[2]) / (b[2] - a[2])
            out.append(a + t * (b - a))
    return out


def build_projection() -> dict:
    from medhop.drone import sim_actors as sa
    from medhop.drone.sim import SimLink

    lenses = ((640, 360, 70.0), (1280, 720, 70.0), (640, 360, 90.0), (1280, 720, 55.0))
    cameras = []
    for w, h, hfov in lenses:
        sim = _TracedSim(_sim_config("drone", {**QUIET, "width": w, "height": h, "hfov_deg": hfov})).sim
        cameras.append({"width": w, "height": h, "hfov_deg": hfov, "focal": sim._focal, "K": sim._K.tolist()})

    rng = random.Random(9090)
    points = []
    for i in range(60):
        lens = i % len(lenses)
        snap = _random_snap(rng)
        cam, rot = SimLink._camera(snap)
        world = [[r6(rng.uniform(-5, 5)), r6(rng.uniform(0, 2.6)), r6(rng.uniform(-8, 0))] for _ in range(6)]
        if i % 5 == 0:   # exactly on the camera's own height and position
            world.append([snap["x"] + 1.0, snap["cam_y"], snap["z"] + 1.0])
        pc = (np.array(world) - cam) @ rot.T
        keep = [k for k in range(len(world)) if abs(pc[k][2]) > 1e-6]
        world = [world[k] for k in keep]
        pc = pc[keep]
        points.append({"snap": [snap["x"], snap["z"], snap["heading"], snap["cam_y"]], "lens": lens, "world": world,
                       "cam": pc.tolist(), "uv": sa.project(pc, np.array(cameras[lens]["K"])).tolist()})

    polygons = []
    shapes = [
        ("wall", [[-5.0, 2.6, 0.0], [5.0, 2.6, 0.0], [5.0, 0.0, 0.0], [-5.0, 0.0, 0.0]]),
        ("floor", [[-5.0, 0.0, 0.0], [5.0, 0.0, 0.0], [5.0, 0.0, -8.0], [-5.0, 0.0, -8.0]]),
        ("sign", [[-0.105, 1.12, 0.0], [0.105, 1.12, 0.0], [0.105, 0.823, 0.0], [-0.105, 0.823, 0.0]]),
    ]
    for i in range(48):
        lens = i % len(lenses)
        near = (sa.NEAR_M, 0.01, 0.3)[i % 3]
        snap = _random_snap(rng)
        if i < 21:
            name, poly = shapes[i % 3]
        else:   # a random triangle or pentagon around the camera, often across the near plane
            name = "random"
            cx, cz = snap["x"], snap["z"]
            poly = [[r6(cx + rng.uniform(-2, 2)), r6(rng.uniform(0, 2.6)), r6(cz + rng.uniform(-2, 2))]
                    for _ in range(rng.choice((3, 5)))]
        cam, rot = SimLink._camera(snap)
        pc = (np.array(poly, dtype=np.float64) - cam) @ rot.T
        clipped = _clip_near(pc, near)
        uv = sa.project(np.array(clipped).reshape(-1, 3), np.array(cameras[lens]["K"])).tolist()
        polygons.append({"name": name, "snap": [snap["x"], snap["z"], snap["heading"], snap["cam_y"]], "lens": lens,
                         "near": near, "world": poly, "cam": pc.tolist(),
                         "clipped": [p.tolist() for p in clipped], "uv": uv})
    return {"cameras": cameras, "points": points, "polygons": polygons}


# ---------------------------------------------------------------------------------------------- #
# sim_harness: SimHarness.step of tests/harness.py with the runner replaced by a recording script

TINY_JPEG_SIDE = 4


class _TruthDetector:
    """Stands in for MarkerDetector in the harness trace: the frame's true marker corners (projected
    from the snapshot it shows) through the real MarkerDetector arithmetic. No detection when the sign
    is hidden, a corner is behind the camera or outside the frame."""

    def __init__(self, traced: _TracedSim, marker_id: int) -> None:
        self.traced = traced
        self.marker_id = marker_id

    def detect(self, image: Any, ts: float = 0.0) -> Any:
        sim = self.traced.sim
        delay = sim.cfg.video_delay_s
        for t, snap in reversed(self.traced.captures):
            if t + delay == ts:
                break
        else:
            raise AssertionError(f"no capture for a frame released at {ts!r}")
        if snap["marker_hidden"]:
            return None
        pc, uv = _marker_truth(sim, snap)
        w, h = sim.cfg.width, sim.cfg.height
        if (pc[:, 2] <= 0).any() or (uv < 0).any() or (uv[:, 0] > w - 1).any() or (uv[:, 1] > h - 1).any():
            return None
        return _python_marker_obs(uv, w, h, self.marker_id, ts)


class _ScriptRunner:
    """Stands in for MissionRunner.step: records every call, takes off once and steers at the marker."""

    def __init__(self, harness: Any, takeoff_at: Optional[float]) -> None:
        self.h = harness
        self.takeoff_at = takeoff_at
        self.calls: List[list] = []

    def step(self, obs: Any, now: float) -> None:
        from medhop.drone.base import clamp
        h = self.h
        toggled = None
        if self.takeoff_at is not None and now >= self.takeoff_at:
            self.takeoff_at = None
            toggled = h.mixer.mission_toggle(now, landing=False)
        if obs is not None and obs.marker is not None:
            m = obs.marker
            h.mixer.mission_command(clamp(1.2 * (m.cx - 0.5)), clamp(2.0 * (0.14 - m.size)), now)
        pose = h.sim.pose()
        row: List[Any] = [now, None if obs is None else _obs_row(obs), [pose[k] for k in SIM_POSE_KEYS]]
        if toggled is not None:
            row.append(toggled)
        self.calls.append(row)


def _obs_row(obs: Any) -> dict:
    m = obs.marker
    return {"ts": obs.ts, "seq": obs.seq, "brightness": obs.brightness,
            "marker": None if m is None else [m.cx, m.cy, m.width, m.height, m.ts],
            "obstacles": [[o.kind, list(o.box), o.ts] for o in obs.obstacles]}


def build_sim_harness() -> dict:
    import cv2
    from medhop.mixer import ControlMixer
    from tests.harness import SimHarness

    tiny = cv2.imencode(".jpg", np.full((TINY_JPEG_SIDE, TINY_JPEG_SIDE), 128, np.uint8))[1].tobytes()
    side = [["person", 1.1, 1.4, 0.45, 0.3, 1.7, 0.0, 0.0, 0.0, 0.0],
            ["object", -1.6, 2.2, 0.5, 0.5, 0.8, 0.4, 0.0, 1.0, 3.0]]
    cases = []
    for name, profile, overrides, dropout, seed, seconds, takeoff_after in (
            ("drone_from_the_ground", "drone", {"start_distance_m": 3.0, "start_heading_deg": 12.0, "actors": side},
             0.25, 5, 10.0, 0.6),
            ("high_airborne", "high", {"start_airborne": True, "start_distance_m": 3.2, "start_heading_deg": -15.0,
                                       "start_x_m": 0.3}, 0.0, 0, 6.0, None)):
        config = {**QUIET, **overrides}
        traced = _TracedSim(_sim_config(profile, config), jpeg=tiny)
        h = SimHarness.__new__(SimHarness)   # the real step(), without the runner, store and checks __init__ builds
        h.clock = traced.clock
        h.marker_dropout = float(dropout)
        h._dropout_rng = random.Random(seed)
        h.sim = traced.sim
        h.mixer = ControlMixer(h.sim, rate_hz=20.0, clock=h.clock)
        h.detector = _TruthDetector(traced, 7)
        h.runner = _ScriptRunner(h, None if takeoff_after is None else h.clock.t + takeoff_after)
        h.sent, h.observations = [], []
        h._last_seq = 0
        h._next_tick = h.clock.t
        h._last_runner_step = h.clock.t
        h.run(seconds)
        cases.append({"name": name, "profile": profile, "config": config, "marker_dropout": dropout,
                      "dropout_seed": seed, "seconds": seconds, "takeoff_after": takeoff_after,
                      "runner_calls": h.runner.calls, "sent": [[t, list(axes)] for t, axes in h.sent],
                      "observations": len(h.observations), "end_clock": h.clock.t})
    return {"physics_dt": SimHarness.PHYSICS_DT, "control_dt": SimHarness.CONTROL_DT, "cases": cases}


# ---------------------------------------------------------------------------------------------- #
# detector_calibration: the real OpenCV detector on the simulator's own pictures, against geometric
# truth (the sign's corners through the simulator's camera). `cases` is deterministic and cheap; the
# measured part renders about 1400 frames and takes about a minute.

CAL_DISTANCES = (0.5, 0.75, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 5.5, 6.0, 7.0)
CAL_OFFSETS = (-0.4, -0.2, 0.0, 0.2, 0.4)
CAL_TURNS = (-20.0, -10.0, 0.0, 10.0, 20.0)
CAL_SEED = 11


def _marker_world(cfg: Any) -> np.ndarray:
    half = cfg.marker_size_m / 2.0
    top, bottom = cfg.marker_height_m + half, cfg.marker_height_m - half
    return np.array([[-half, top, 0.0], [half, top, 0.0], [half, bottom, 0.0], [-half, bottom, 0.0]])


def _marker_truth(sim: Any, snap: dict) -> Tuple[np.ndarray, np.ndarray]:
    """The station marker's corners (TL, TR, BR, BL as printed) in camera coordinates and in pixels."""
    from medhop.drone.sim import SimLink
    from medhop.drone.sim_actors import project
    cam, rot = SimLink._camera(snap)
    pc = (_marker_world(sim.cfg) - cam) @ rot.T
    return pc, project(pc, sim._K)


class _CornerSource:
    """Replaces the OpenCV detector inside MarkerDetector: reports exactly the corners it is given."""

    def __init__(self) -> None:
        self.quad: Optional[np.ndarray] = None
        self.marker_id = 7

    def detectMarkers(self, _gray: Any) -> Any:   # noqa: N802 (OpenCV's name)
        if self.quad is None:
            return (), None, ()
        return (self.quad.reshape(1, 4, 2),), np.array([[self.marker_id]]), ()


def _python_marker_obs(corners: Any, w: int, h: int, marker_id: int, ts: float) -> Any:
    """MarkerDetector.detect's own arithmetic (and its MIN_WIDTH filter) on the given corners."""
    detector = marker_module.MarkerDetector(marker_id)
    source = _CornerSource()
    source.quad = np.asarray(corners, dtype=np.float64)
    source.marker_id = marker_id
    detector._detector = source
    return detector.detect(np.broadcast_to(np.uint8(0), (int(h), int(w))), ts=ts)


def _obs_fields(obs: Any) -> Any:
    if obs is None:
        return None
    return {"id": obs.id, "cx": obs.cx, "cy": obs.cy, "width": obs.width, "height": obs.height,
            "corners": [list(c) for c in obs.corners], "ts": obs.ts, "frame_w": obs.frame_w, "frame_h": obs.frame_h}


def build_detector_cases() -> List[dict]:
    """Poses with the true corners (depth and pixels) and what MarkerDetector computes from them."""
    rng = random.Random(777)
    cases = []
    for profile in ("drone", "high"):
        sim = _TracedSim(_sim_config(profile, QUIET)).sim
        for i in range(45):
            if i < 6:   # behind, beside, below the sign, far away, and very close
                d, x, turn, cam_y = ((1.0, 0.0, 180.0, 1.04), (1.5, 0.0, 60.0, 1.04), (2.0, 0.0, 0.0, 0.04),
                                     (8.0, 0.0, 0.0, 1.04), (0.2, 0.0, 0.0, 1.0), (0.3, 0.05, 5.0, 1.04))[i]
            else:
                d, x = r6(rng.uniform(0.3, 7.5)), r6(rng.uniform(-1.5, 1.5))
                turn, cam_y = r6(rng.uniform(-30.0, 30.0)), r6(rng.uniform(0.3, 1.9))
            snap = _hover_snap(d, x, math.atan2(-x, d) + math.radians(turn), cam_y)
            pc, uv = _marker_truth(sim, snap)
            ts = r6(1000.0 + i * 0.07)
            obs = _python_marker_obs(uv, sim.cfg.width, sim.cfg.height, 7, ts)
            cases.append({"profile": profile, "snap": [snap["x"], snap["z"], snap["heading"], snap["cam_y"]],
                          "ts": ts, "depth": pc[:, 2].tolist(), "corners": uv.tolist(), "obs": _obs_fields(obs)})
    return cases


def _stats(values: Sequence[float]) -> Optional[dict]:
    if not values:
        return None
    v = np.asarray(values, dtype=np.float64)
    return {"mean": round(float(v.mean()), 4), "median": round(float(np.median(v)), 4),
            "p95": round(float(np.percentile(v, 95)), 4), "max": round(float(v.max()), 4)}


def _border_margin(uv: np.ndarray, w: int, h: int) -> float:
    """Smallest distance (pixels) from a corner to the frame's edge pixels; negative when one is outside."""
    return float(min(uv[:, 0].min(), uv[:, 1].min(), (w - 1) - uv[:, 0].max(), (h - 1) - uv[:, 1].max()))


def _true_width(uv: np.ndarray, w: int) -> float:
    return 0.5 * (float(np.linalg.norm(uv[1] - uv[0])) + float(np.linalg.norm(uv[2] - uv[3]))) / w


def _detect_rendered(sim: Any, detector: Any, snap: dict) -> Tuple[Any, float]:
    import cv2
    gray = cv2.imdecode(np.frombuffer(sim._render_jpeg(snap), np.uint8), cv2.IMREAD_GRAYSCALE)
    return detector.detect(gray), float(gray.mean())


def _actor_silhouette(sim: Any, actor: Any, snap: dict) -> np.ndarray:
    from medhop.drone import sim_actors as sa
    from medhop.drone.sim import SimLink
    cam, rot = SimLink._camera(snap)
    return sa.project(sa.camera_points(actor, cam, rot), sim._K)


_SIGN_RECTS: Dict[Tuple[int, float, float], Tuple[int, int, int]] = {}


def _drawn_marker_truth(sim: Any, snap: dict) -> np.ndarray:
    """The marker's corners in pixels as the renderer actually draws them: on the sign texture level it
    picks for this depth (wanted = focal / depth * 1.25 in the plain scene, render focal / depth * 1.1
    in the room), with the texture's whole-pixel marker rectangle, whose edges lie half a texel
    outside the centres of its first and last pixels (warpPerspective maps texel centres)."""
    from medhop.drone.sim import SimLink
    from medhop.drone.sim_actors import project
    from medhop.vision.marker import station_sign
    c = sim.cfg
    cam, rot = SimLink._camera(snap)
    depth = float(rot[2] @ (np.array([0.0, c.marker_height_m, 0.0]) - cam))
    wanted = (sim._focal / depth * 1.25 if c.scene == "plain"
              else sim._focal * max(1, int(c.supersample)) / depth * 1.1)
    ppm = sim._sign_levels[0][0]
    for level_ppm, _sheet in sim._sign_levels:
        if level_ppm >= wanted:
            ppm = level_ppm
    key = (c.marker_id, c.marker_size_m, ppm)
    if key not in _SIGN_RECTS:
        _SIGN_RECTS[key] = station_sign(c.marker_id, c.marker_size_m, ppm)[1]
    x0, y0, side = _SIGN_RECTS[key]
    left, top = sim._sign_left_x + (x0 - 0.5) / ppm, sim._sign_top_y - (y0 - 0.5) / ppm
    right, bottom = left + side / ppm, top - side / ppm
    world = np.array([[left, top, 0.0], [right, top, 0.0], [right, bottom, 0.0], [left, bottom, 0.0]])
    return project((world - cam) @ rot.T, sim._K)


def _solve(f: Callable[[float], float], target: float, lo: float, hi: float) -> float:
    """Bisection for an increasing f: the argument where f reaches target."""
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if f(mid) < target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def _measure_profile(profile: str) -> dict:
    from medhop.drone.sim import SimLink
    from medhop.drone.sim_actors import Actor
    from medhop.vision.marker import MarkerDetector

    sim = SimLink(_sim_config(profile, {"seed": CAL_SEED}), realtime=False)
    detector = MarkerDetector(sim.cfg.marker_id)
    w, h = sim.cfg.width, sim.cfg.height
    min_width = MarkerDetector.MIN_WIDTH

    by_distance, all_err, all_coord, all_drawn, all_centred, brightness = [], [], [], [], [], []
    for d in CAL_DISTANCES:
        n_view = n_found = n_found_outside = n_outside = 0
        err, du, dv, coord, width_rel, drawn = [], [], [], [], [], []
        for x in CAL_OFFSETS:
            for turn in CAL_TURNS:
                snap = _hover_snap(d, x, math.atan2(-x, d) + math.radians(turn))
                pc, uv = _marker_truth(sim, snap)
                obs, mean_grey = _detect_rendered(sim, detector, snap)
                brightness.append(mean_grey)
                in_view = bool((pc[:, 2] > 0).all()) and _border_margin(uv, w, h) >= 0.0 \
                    and _true_width(uv, w) >= min_width
                if not in_view:
                    n_outside += 1
                    n_found_outside += obs is not None
                    continue
                n_view += 1
                if obs is None:
                    continue
                n_found += 1
                got = np.asarray(obs.corners, dtype=np.float64)
                diff = got - uv
                err.extend(np.hypot(diff[:, 0], diff[:, 1]).tolist())
                du.extend(diff[:, 0].tolist())
                dv.extend(diff[:, 1].tolist())
                coord.extend(diff.ravel().tolist())
                width_rel.append(obs.width / _true_width(uv, w) - 1.0)
                off = got - _drawn_marker_truth(sim, snap)
                drawn.extend(np.hypot(off[:, 0], off[:, 1]).tolist())
        all_err += err
        all_coord += coord
        all_drawn += drawn
        if du:
            all_centred += (np.asarray(du) - np.mean(du)).tolist() + (np.asarray(dv) - np.mean(dv)).tolist()
        by_distance.append({
            "distance_m": d, "poses": len(CAL_OFFSETS) * len(CAL_TURNS), "in_view": n_view, "found": n_found,
            "miss_rate": None if n_view == 0 else round(1.0 - n_found / n_view, 4),
            "outside_view": n_outside, "found_outside_view": int(n_found_outside),
            "marker_px": round(sim._focal * sim.cfg.marker_size_m / d, 2),
            "corner_error_px": _stats(err),
            "bias_u_px": None if not du else round(float(np.mean(du)), 4),
            "bias_v_px": None if not dv else round(float(np.mean(dv)), 4),
            "rms_per_coordinate_px": None if not coord else round(float(np.sqrt(np.mean(np.square(coord)))), 4),
            "std_u_px": None if not du else round(float(np.std(du)), 4),
            "std_v_px": None if not dv else round(float(np.std(dv)), 4),
            "width_rel_error_mean": None if not width_rel else round(float(np.mean(width_rel)), 5),
            "corner_error_vs_drawn_px": _stats(drawn),
        })

    # the frame's edge: turn until the sign leaves the picture on the left (or, below, the top)
    edge = []
    for d in (1.0, 2.0, 3.0):
        for k in range(25):
            target = -4.0 + 0.5 * k        # smallest distance from a true corner to the frame's edge pixels
            turn = _solve(lambda t: -_border_margin(_marker_truth(sim, _hover_snap(d, 0.0, t))[1], w, h),
                          -target, math.radians(0.0), math.radians(60.0))
            snap = _hover_snap(d, 0.0, turn)
            pc, uv = _marker_truth(sim, snap)
            obs, _grey = _detect_rendered(sim, detector, snap)
            edge.append({"distance_m": d, "edge": "left", "margin_px": round(_border_margin(uv, w, h), 3),
                         "found": obs is not None})
    for d in (1.5,):
        for k in range(25):
            target = -4.0 + 0.5 * k
            cam_y = _solve(lambda y: _border_margin(_marker_truth(sim, _hover_snap(d, 0.0, 0.0, y))[1], w, h),
                           target, 0.2, 1.04)     # lower: the sign rises to the top edge
            snap = _hover_snap(d, 0.0, 0.0, cam_y)
            pc, uv = _marker_truth(sim, snap)
            obs, _grey = _detect_rendered(sim, detector, snap)
            edge.append({"distance_m": d, "edge": "top", "margin_px": round(_border_margin(uv, w, h), 3),
                         "found": obs is not None})
    found_margins = [e["margin_px"] for e in edge if e["found"]]
    missed_inside = [e["margin_px"] for e in edge if not e["found"] and e["margin_px"] >= 0]

    # an actor covering the sign: from the side (a person) and from below (an object)
    hiding = []
    for d in (1.5, 2.5, 3.5):
        snap0 = _hover_snap(d, 0.0, 0.0)
        _pc, muv = _marker_truth(sim, snap0)
        left_u, bottom_v = float(muv[:, 0].min()), float(muv[:, 1].max())
        for side_name in ("side", "below"):
            for k in range(41):
                target = -10.0 + 0.5 * k        # how far the silhouette reaches into the marker square, px
                if side_name == "side":
                    def reach(x_m: float) -> float:
                        a = Actor("person", x_m=x_m, distance_m=0.8, width_m=0.5, depth_m=0.2, height_m=2.0)
                        return float(_actor_silhouette(sim, a, snap0)[:, 0].max()) - left_u
                    x_m = _solve(reach, target, -2.0, 0.6)
                    actor = Actor("person", x_m=x_m, distance_m=0.8, width_m=0.5, depth_m=0.2, height_m=2.0)
                else:
                    def rise(height_m: float) -> float:
                        a = Actor("object", x_m=0.0, distance_m=0.8, width_m=0.6, depth_m=0.2, height_m=height_m)
                        return bottom_v - float(_actor_silhouette(sim, a, snap0)[:, 1].min())
                    height_m = _solve(rise, target, 0.2, 1.03)
                    actor = Actor("object", x_m=0.0, distance_m=0.8, width_m=0.6, depth_m=0.2, height_m=height_m)
                snap = dict(snap0, actors=(actor,))
                obs, _grey = _detect_rendered(sim, detector, snap)
                worst = None
                if obs is not None:
                    diff = np.asarray(obs.corners, dtype=np.float64) - muv
                    worst = round(float(np.hypot(diff[:, 0], diff[:, 1]).max()), 3)
                hiding.append({"distance_m": d, "from": side_name, "reach_px": target, "found": obs is not None,
                               "worst_corner_error_px": worst, "actor": _actor_row(actor)})
    found_reach = [r["reach_px"] for r in hiding if r["found"]]
    missed_reach = [r["reach_px"] for r in hiding if not r["found"]]

    ground_snap = _hover_snap(sim.cfg.start_distance_m, 0.0, 0.0, cam_y=0.04)
    _obs, ground_grey = _detect_rendered(sim, detector, ground_snap)
    in_view_total = sum(row["in_view"] for row in by_distance)
    found_total = sum(row["found"] for row in by_distance)
    return {
        "profile": profile, "width": w, "height": h, "focal_px": sim._focal, "seed": CAL_SEED,
        "grid": {"distances_m": list(CAL_DISTANCES), "offsets_m": list(CAL_OFFSETS),
                 "turns_from_sign_deg": list(CAL_TURNS), "cam_y_m": 1.04},
        "by_distance": by_distance,
        "overall": {"in_view": in_view_total, "found": found_total,
                    "miss_rate": round(1.0 - found_total / in_view_total, 4),
                    "corner_error_px": _stats(all_err),
                    "rms_per_coordinate_px": round(float(np.sqrt(np.mean(np.square(all_coord)))), 4),
                    "std_per_coordinate_without_bias_px": round(float(np.std(all_centred)), 4),
                    "corner_error_vs_drawn_px": _stats(all_drawn)},
        "edge": {"rows": edge, "smallest_margin_found_px": min(found_margins) if found_margins else None,
                 "largest_margin_missed_px": max(missed_inside) if missed_inside else None},
        "hiding": {"rows": hiding, "largest_reach_found_px": max(found_reach) if found_reach else None,
                   "smallest_reach_missed_px": min(missed_reach) if missed_reach else None},
        "brightness": {"hover_median": round(float(np.median(brightness)), 2),
                       "ground_at_start": round(ground_grey, 2)},
    }


def build_detector_calibration() -> dict:
    return {"min_width": marker_module.MarkerDetector.MIN_WIDTH, "cases": build_detector_cases(),
            "measured": [_measure_profile("high"), _measure_profile("drone")]}


# ---------------------------------------------------------------------------------------------- #
# marker7: the station sign's marker as OpenCV draws it, for the line drawing in frontend/src/scene

def build_marker7() -> dict:
    """ArUco DICT_4X4_50 id 7 at one pixel per cell: cv2.aruco.generateImageMarker(dictionary, 7, 6)
    (marker.marker_image, which the printed sign uses). Six rows of six cells including the one-cell
    black border, top row first, 1 = white."""
    image = marker_module.marker_image(7, 6)
    return {"dictionary": marker_module.ARUCO_DICT_NAME, "id": 7, "side_cells": int(image.shape[0]),
            "bits": [[int(v > 127) for v in row] for row in image]}


# ---------------------------------------------------------------------------------------------- #
# runner_*: mission/runner.py and the mixer it drives, recorded call by call for an open-loop replay
#
# Every call the runner and the mixer get from outside is an op: runner.step(obs, now) ("s"),
# mixer.tick(now) ("k"), and whatever the scenario does (start, abort, the setters, pilot input, ...).
# Each op records its inputs, what the link reported before it (only what changed: the latest frame's
# timestamp and sequence "f", the telemetry "tel", the link mode, the person status, the pilot link),
# what it returned ("out"), what the runner handed the mixer ("cmd" mission commands, "mt" mission
# toggles, "clr" clear_mission_command calls), what the link was asked and answered besides frames and
# telemetry ("lk": control_up, toggle, estop, calibrate), the store writes ("store"), the log lines
# ("log"), every line-up pose fit with Python's one-ulp spread of it ("fits", the rule of the pose group),
# and after every op but a tick the runner's whole public state: snapshot() plus obstacles_snapshot(),
# hover_snapshot(), settings(), ready_for_dose, auto_fly, avoid_mode and arrive_width ("S": the keys that
# changed since the previous op; the first op has all of them). frontend/src/engine/mission/runner.test.ts
# replays the ops into the TypeScript runner and mixer over a link that answers what was recorded.
#
# Closed-loop scenarios are real SimHarness runs (tests/harness.py: rendering and the OpenCV detector);
# the runner and the mixer are rebuilt on a recording proxy of the simulator link. Observations are
# rounded before the runner sees them (cx, cy, width, height to 9 decimals, corners to 1e-4 px), which
# keeps the files small: the Python runner sees exactly the recorded values. Scripted scenarios drive the
# runner like tests/test_runner.py (a RecordingLink, synthetic detections, the line-up off). Run ids are
# made deterministic for the files: the stamp in UTC instead of local time and a counter instead of
# secrets.token_hex.

RUNNER_WALL_EPOCH = 1_794_000_000.0      # tests/harness.py WALL_EPOCH
# The scripted scenarios step 1/16 s (tests/test_runner.py: 1/15 s) and every time step is a multiple
# of 1/16 s, so their times are exact binary fractions with short decimal forms.
RUNNER_DT = 1.0 / 16.0
_NO_OUT = object()


def _runner_spread(corners: Any, w: Any, h: Any, size_m: float, hfov: float, iterations: int, base: Any,
                   seed: int) -> Any:
    """_python_spread's two nudge patterns plus 16 random ones (each coordinate moved one unit in the last
    place up or down, or left, at random; seeded per fit). The line-up's poses are close and nearly
    square-on, where the two fixed patterns can miss most of the instability: for some of these fits
    Python's own answer moves a hundred times further under a random one-ulp nudge."""
    spread = _python_spread(corners, w, h, size_m, hfov, iterations, base)
    if spread is None:
        return None
    rng = random.Random(seed)
    for _ in range(16):
        nudged = [[math.nextafter(v, rng.choice((INF, -INF))) if rng.random() < 0.75 else v for v in c]
                  for c in corners]
        pose = fit_sign_pose(nudged, w, h, size_m, hfov, iterations)
        for name in POSE_FIELDS:
            change = INF if pose is None else abs(getattr(pose, name) - base[name])
            spread[name] = max(spread[name], change)
    return spread


def _round_up_2(x: float) -> float:
    """x to two significant digits, rounded away from zero (a recorded spread is a tolerance)."""
    if x == 0.0 or not math.isfinite(x):
        return x
    exponent = math.floor(math.log10(abs(x))) - 1
    return math.ceil(x / 10.0 ** exponent) * 10.0 ** exponent


class _UtcDatetime:
    """Stands in for datetime in mission/runner.py: fromtimestamp in UTC, so run ids do not depend on the
    machine's time zone."""

    @staticmethod
    def fromtimestamp(ts: float) -> Any:
        from datetime import datetime, timezone
        return datetime.fromtimestamp(ts, timezone.utc).replace(tzinfo=None)


def _rounded_obs(obs: Any) -> Any:
    from medhop.vision.marker import MarkerObs, Observation
    m = obs.marker
    if m is not None:
        m = MarkerObs(id=m.id, cx=r9(m.cx), cy=r9(m.cy), width=r9(m.width),
                      corners=tuple((round(float(x), 4), round(float(y), 4)) for x, y in m.corners),
                      ts=m.ts, height=r9(m.height), frame_w=m.frame_w, frame_h=m.frame_h)
    return Observation(ts=obs.ts, seq=obs.seq, marker=m, brightness=obs.brightness, obstacles=tuple(obs.obstacles))


def _obs_record(obs: Any, now: float, frame_size: List[int], previous: List[Any]) -> Any:
    """[ts, seq, marker, obstacles]: ts null when it is the op's time; marker [cx, cy, width, height,
    [8 corner coordinates] or null when they are the previous marker's] (its id is 7, its ts the
    observation's, its frame size the scenario's); obstacles [[kind, x1, y1, x2, y2]] (each stamped with
    the observation's ts). `previous` holds the last corners written."""
    if obs is None:
        return None
    m = obs.marker
    marker = None
    if m is not None:
        assert m.ts == obs.ts and [m.frame_w, m.frame_h] == frame_size and m.id == 7, "a marker the replay can rebuild"
        corners = [float(v) for c in m.corners for v in c]
        marker = [m.cx, m.cy, m.width, m.height, None if corners == previous[0] else corners]
        previous[0] = corners
    for o in obs.obstacles:
        assert o.ts == obs.ts, "obstacles carry the frame's time"
    return [None if obs.ts == now else obs.ts, obs.seq, marker, [[o.kind, *o.box] for o in obs.obstacles]]


def _person_record(p: Any) -> list:
    return [p.enabled, p.detected, p.count, p.ts, [list(b) for b in p.boxes]]


def _trace_record(trace: Dict[str, Any]) -> Dict[str, Any]:
    """The run trace as written, with its samples (which all share keys) column by column, each column
    run-length encoded: {"keys": [...], "n": count, "columns": [[[value, repeats], ...], ...]}."""
    out = encode(trace)
    samples = out["samples"]
    keys = list(samples[0]) if samples else []
    columns = []
    for key in keys:
        runs: List[list] = []
        for s in samples:
            assert list(s) == keys, "every sample of a run has the same keys"
            if runs and json.dumps(runs[-1][0]) == json.dumps(s[key]):
                runs[-1][1] += 1
            else:
                runs.append([s[key], 1])
        columns.append(runs)
    out["samples"] = {"keys": keys, "n": len(samples), "columns": columns}
    return out


class _RunnerRecorder:
    def __init__(self, inner: Any, clock: Any, person: Callable[[], Any], pilot: Optional[Callable[[], bool]]) -> None:
        self.inner = inner
        self.clock = clock
        self.person = person
        self.pilot = pilot
        self.ops: List[dict] = []
        self.cur: Optional[dict] = None
        self.env: Dict[str, Any] = {}
        self.state: Dict[str, str] = {}
        self.runner: Any = None
        self.capture = _LogCapture()
        self._log_start = 0
        self.frame_size = [640, 360]
        self.run_ids = 0
        self.corners: List[Any] = [None]
        self.last_axes: Optional[List[float]] = None
        self.fits = 0

    # -- what the link shows -------------------------------------------------------------------- #
    def env_now(self) -> Dict[str, Any]:
        f = self.inner.latest_frame()
        tel = self.inner.telemetry()
        return {"f": None if f is None else [f.timestamp, f.seq],
                "tel": None if tel is None else [tel.fly_state_raw, tel.battery_raw, tel.flags_raw, tel.timestamp],
                "mode": self.inner.mode,
                "person": _person_record(self.person()),
                "pilot": None if self.pilot is None else bool(self.pilot())}

    def check(self, key: str, value: Any) -> None:
        if self.cur is not None:
            assert self.env[key] == value, f"the link's {key} changed inside an op: the replay would not see it"

    # -- ops ------------------------------------------------------------------------------------- #
    def begin(self, kind: str, now: float, **inputs: Any) -> dict:
        assert self.cur is None, "ops do not nest"
        op: Dict[str, Any] = {"o": kind, "t": now, **{k: encode(v) for k, v in inputs.items()}}
        env = self.env_now()
        for key, value in env.items():
            if key not in self.env or json.dumps(self.env[key]) != json.dumps(value):
                op[key] = value
        self.env = env
        self.cur = op
        self._log_start = len(self.capture.records)
        return op

    def effect(self, key: str, value: Any) -> None:
        assert self.cur is not None, f"{key} outside an op: not replayable"
        self.cur.setdefault(key, []).append(encode(value))

    def end(self, out: Any = _NO_OUT, snapshot: bool = True) -> None:
        op = self.cur
        assert op is not None
        if out is not _NO_OUT:
            op["out"] = encode(out)
        logs = self.capture.records[self._log_start:]
        if logs:
            op["log"] = logs
        if snapshot:
            state = self.public_state(op["t"])
            changed = {k: v for k, v in state.items() if k not in self.state or self.state[k] != json.dumps(v)}
            if changed:
                op["S"] = changed
            self.state = {k: json.dumps(v) for k, v in state.items()}
        self.cur = None
        self.ops.append(op)

    def public_state(self, now: float) -> Dict[str, Any]:
        r = self.runner
        return encode({**r.snapshot(now), "_obstacles": r.obstacles_snapshot(now), "_hover": r.hover_snapshot(now),
                       "_settings": r.settings(), "_ready_for_dose": r.ready_for_dose, "_auto_fly": r.auto_fly,
                       "_avoid_mode": r.avoid_mode, "_arrive_width": r.arrive_width, "_state": r.state,
                       "_reason": r.reason})

    def call(self, kind: str, fn: Callable[[], Any], snapshot: bool = True, **inputs: Any) -> Any:
        self.begin(kind, self.clock.t, **inputs)
        try:
            out = fn()
        except ValueError as exc:
            out = {"error": "ValueError", "message": str(exc)}
        self.end(out, snapshot=snapshot)
        return out

    # -- wiring ---------------------------------------------------------------------------------- #
    def wire(self, runner: Any, mixer: Any) -> None:
        """Wrap runner.step and mixer.tick (instance attributes) so every call becomes an op."""
        self.runner = runner
        real_step, real_tick = runner.step, mixer.tick

        def step(obs: Any, now: Optional[float] = None) -> None:
            now = self.clock() if now is None else now
            if obs is not None:
                obs = _rounded_obs(obs)
            op = self.begin("s", now, obs=_obs_record(obs, now, self.frame_size, self.corners))
            if obs is not None and op.get("f") == [obs.ts, obs.seq]:
                op["f"] = 1          # the frame this observation came from
            real_step(obs, now)
            self.end()

        def tick(now: Optional[float] = None) -> Any:
            now = self.clock() if now is None else now
            self.begin("k", now)
            axes = list(real_tick(now))
            if axes == self.last_axes:
                self.end(snapshot=False)       # no "out": the same axes as the previous tick
            else:
                self.end(axes, snapshot=False)
            self.last_axes = axes
            return tuple(axes)

        runner.step = step
        mixer.tick = tick

    def recording(self) -> Any:
        import contextlib
        import types

        recorder = self

        @contextlib.contextmanager
        def ctx():
            from medhop.mission import runner as runner_module

            def fit(corners, frame_w, frame_h, marker_size_m, hfov_deg, iterations=12):
                pose = fit_sign_pose(corners, frame_w, frame_h, marker_size_m, hfov_deg, iterations)
                out = _pose_out(pose)
                spread = _runner_spread([list(c) for c in corners], frame_w, frame_h, marker_size_m, hfov_deg,
                                        iterations, out, recorder.fits)
                recorder.fits += 1
                recorder.effect("fits", [None if out is None else [out[k] for k in POSE_FIELDS],
                                         None if spread is None else [_round_up_2(spread[k]) for k in POSE_FIELDS]])
                return pose

            def token_hex(n: int) -> str:
                recorder.run_ids += 1
                return f"{recorder.run_ids:0{2 * n}x}"

            logger = logging.getLogger("medhop.mission")
            mixer_logger = logging.getLogger("medhop.mixer")     # its lines are the mixer group's business
            saved = (logger.level, logger.propagate, logging.root.manager.disable, mixer_logger.disabled)
            logging.disable(logging.NOTSET)
            logger.addHandler(recorder.capture)
            logger.setLevel(logging.DEBUG)
            logger.propagate = False
            mixer_logger.disabled = True
            try:
                with mock.patch.object(runner_module, "fit_sign_pose", fit), \
                        mock.patch.object(runner_module, "datetime", _UtcDatetime), \
                        mock.patch.object(runner_module, "secrets", types.SimpleNamespace(token_hex=token_hex)):
                    yield
            finally:
                logger.removeHandler(recorder.capture)
                logger.setLevel(saved[0])
                logger.propagate = saved[1]
                logging.disable(saved[2])
                mixer_logger.disabled = saved[3]

        return ctx()


class _ProxyLink:
    """The DroneLink the runner and the mixer see: the real one, with every answer recorded."""

    def __init__(self, inner: Any, rec: _RunnerRecorder) -> None:
        self.inner = inner
        self.rec = rec

    @property
    def mode(self) -> str:
        return self.inner.mode

    def latest_frame(self) -> Any:
        f = self.inner.latest_frame()
        self.rec.check("f", None if f is None else [f.timestamp, f.seq])
        return f

    def telemetry(self) -> Any:
        t = self.inner.telemetry()
        self.rec.check("tel", None if t is None else [t.fly_state_raw, t.battery_raw, t.flags_raw, t.timestamp])
        return t

    def set_axes(self, throttle: float, yaw: float, pitch: float, roll: float) -> None:
        self.inner.set_axes(throttle, yaw, pitch, roll)

    def takeoff_land_toggle(self) -> bool:
        result = self.inner.takeoff_land_toggle()
        self.rec.effect("lk", ["toggle", result])
        return result

    def emergency_stop(self) -> bool:
        result = self.inner.emergency_stop()
        self.rec.effect("lk", ["estop", result])
        return result

    def control_up(self) -> bool:
        result = self.inner.control_up()
        self.rec.effect("lk", ["control_up", result])
        return result

    def drone_seen(self) -> bool:
        return self.inner.drone_seen()

    def calibrate(self) -> None:
        self.inner.calibrate()
        self.rec.effect("lk", ["calibrate", None])

    def start(self) -> None:
        self.inner.start()

    def stop(self) -> None:
        self.inner.stop()


def _spy_mixer(link: Any, rec: _RunnerRecorder, clock: Any) -> Any:
    class SpyMixer(ControlMixer):
        """Records what the runner hands the mixer."""

        def mission_command(self, yaw: float, pitch: float, now: Optional[float] = None, roll: float = 0.0) -> None:
            rec.effect("cmd", [yaw, pitch, roll])
            super().mission_command(yaw, pitch, now, roll=roll)

        def mission_toggle(self, now: Optional[float] = None, landing: bool = True) -> bool:
            result = super().mission_toggle(now, landing=landing)
            rec.effect("mt", [landing, result])
            return result

        def clear_mission_command(self) -> None:
            rec.effect("clr", 1)
            super().clear_mission_command()

    return SpyMixer(link, rate_hz=20.0, clock=clock)


class _RecordingStore:
    """The real CareStore, with every write the runner makes recorded ("store" of the op)."""

    def __init__(self, inner: Any, rec: _RunnerRecorder) -> None:
        self._inner = inner
        self._rec = rec

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)

    def add_event(self, event_type: str, dose_id: Optional[str] = None, run_id: Optional[str] = None,
                  detail: Optional[Dict[str, Any]] = None, ts: Optional[float] = None) -> Any:
        self._rec.effect("store", ["event", event_type, dose_id, run_id, detail, ts])
        return self._inner.add_event(event_type, dose_id=dose_id, run_id=run_id, detail=detail, ts=ts)

    def write_run_trace(self, run_id: str, trace: Dict[str, Any]) -> Any:
        self._rec.effect("store", ["trace", run_id, _trace_record(trace)])
        return self._inner.write_run_trace(run_id, trace)

    def _save(self, name: str, value: Any) -> None:
        self._rec.effect("store", [name, value])
        getattr(self._inner, name)(value)

    def save_arrive_width(self, width: float) -> None:
        self._save("save_arrive_width", width)

    def save_land_on_arrival(self, enabled: bool) -> None:
        self._save("save_land_on_arrival", enabled)

    def save_drift_assist(self, enabled: bool) -> None:
        self._save("save_drift_assist", enabled)

    def save_auto_fly(self, enabled: bool) -> None:
        self._save("save_auto_fly", enabled)

    def save_avoid(self, mode: str) -> None:
        self._save("save_avoid", mode)


def _scenario_init(settings: Any, runner_config: Any, rec: _RunnerRecorder, store: Any, avoid_config: Any = None,
                   **extra: Any) -> dict:
    from medhop.mission.runner import RunnerConfig
    from medhop.mission.avoid import AvoidConfig
    defaults = dataclasses.asdict(RunnerConfig())
    overrides = {k: v for k, v in dataclasses.asdict(runner_config or RunnerConfig()).items() if defaults[k] != v}
    avoid_defaults = dataclasses.asdict(AvoidConfig(hfov_deg=settings.camera_hfov_deg))
    avoid_overrides = ({} if avoid_config is None else
                       {k: v for k, v in dataclasses.asdict(avoid_config).items() if avoid_defaults[k] != v})
    return {"settings": {name: getattr(settings, name) for name in SETTINGS_FIELDS},
            "runner_config": overrides, "avoid_config": avoid_overrides,
            "pilot_check": rec.pilot is not None, "frame_size": rec.frame_size, "marker_id": settings.marker_id,
            "loads": {"arrive_width": store.load_arrive_width(), "land_on_arrival": store.load_land_on_arrival(),
                      "drift_assist": store.load_drift_assist(), "auto_fly": store.load_auto_fly(),
                      "avoid": store.load_avoid()},
            **extra}


class _Ops:
    """The scenario's own calls (start, abort, the setters, pilot input), each recorded as an op. `runner`,
    `mixer` and `link` are the objects the runner was built with; `inner` the raw link."""

    def __init__(self, rec: _RunnerRecorder, runner: Any, mixer: Any, clock: Any, settings: Any) -> None:
        self.rec, self.runner, self.mixer, self.clock, self.settings = rec, runner, mixer, clock, settings

    def start(self, confirm: bool = True, dose: Optional[str] = "d1", automatic: bool = False) -> Any:
        rec = self.rec
        rec.begin("start", self.clock.t, c=confirm, d=dose, a=automatic)
        out = self.runner.start(confirm, dose, now=self.clock.t, automatic=automatic)
        if out[0]:
            rec.cur["rid"] = self.runner.snapshot(self.clock.t)["run_id"]
        rec.end(out)
        return out

    def abort(self, reason: str = "pilot_took_over") -> Any:
        return self.rec.call("abort", lambda: self.runner.abort(reason, now=self.clock.t), r=reason)

    def set(self, name: str, value: Any) -> Any:
        method = {"land_on_arrival": "set_land_on_arrival", "drift_assist": "set_drift_assist",
                  "auto_fly": "set_auto_fly", "avoid": "set_avoid"}[name]
        return self.rec.call("set", lambda: getattr(self.runner, method)(value), n=name, v=value)

    def hover(self) -> Any:
        return self.rec.call("hover", lambda: self.runner.start_hover_test(now=self.clock.t))

    def calibrate(self) -> Any:
        return self.rec.call("calibrate", lambda: self.runner.calibrate_arrival(now=self.clock.t))

    def ready(self) -> Any:
        return self.rec.call("ready", self.runner.mark_ready_for_dose)

    def note(self) -> Any:
        return self.rec.call("note", self.runner.note_pilot_input)

    def blockers(self) -> Any:
        return self.rec.call("blockers", lambda: self.runner.blockers(now=self.clock.t))

    def flush(self) -> Any:
        return self.rec.call("flush", self.runner.flush)

    def pilot_axes(self, *v: float) -> Any:
        return self.rec.call("pilot_axes", lambda: self.mixer.pilot_axes(*v, now=self.clock.t), v=list(v))

    def pilot_toggle(self) -> Any:
        def fn() -> Any:
            r = self.mixer.pilot_toggle(self.clock.t)
            return [r.ok, r.message, r.code]
        return self.rec.call("pilot_toggle", fn)

    def pilot_estop(self) -> Any:
        return self.rec.call("pilot_estop", lambda: self.mixer.pilot_estop(self.clock.t))

    def estop_reset(self) -> Any:
        return self.rec.call("estop_reset", self.mixer.estop_reset)

    def pilot_disconnect(self) -> Any:
        return self.rec.call("pilot_disconnect", self.mixer.pilot_disconnect)

    def set_trim(self, roll: float, pitch: float) -> Any:
        return self.rec.call("set_trim", lambda: list(self.mixer.set_trim(roll, pitch)), v=[roll, pitch])

    def settings_field(self, **fields: Any) -> Any:
        def fn() -> None:
            for key, value in fields.items():
                setattr(self.settings, key, value)
        return self.rec.call("settings", fn, v=fields)


def _record_closed_loop(name: str, description: str, sim_config: Any, script: Callable[[Any, _Ops], None],
                        runner_config: Any = None, dropout: float = 0.0, seed: int = 0,
                        avoid_config: Any = None) -> dict:
    """A SimHarness run (tests/harness.py) with the runner and the mixer rebuilt on a recording proxy."""
    from medhop.mission.runner import MissionRunner
    from tests.harness import SimHarness
    h = SimHarness(sim_config, runner_config=runner_config, marker_dropout=dropout, dropout_seed=seed)
    try:
        rec = _RunnerRecorder(h.sim, h.clock, lambda: h.person, None)
        rec.frame_size = [h.sim.cfg.width, h.sim.cfg.height]
        link = _ProxyLink(h.sim, rec)
        mixer = _spy_mixer(link, rec, h.clock)
        store = _RecordingStore(h.store, rec)
        runner = MissionRunner(link, mixer, store, h.settings, clock=h.clock, wall_clock=h.wall,
                               person_status=lambda: h.person, config=runner_config, avoid_config=avoid_config)
        mixer.on_pilot_input = lambda kind: runner.abort("estop" if kind == "estop" else "pilot_took_over")
        h.mixer, h.store, h.runner = mixer, store, runner
        rec.wire(runner, mixer)
        init = _scenario_init(h.settings, runner_config, rec, store, avoid_config, kind="closed_loop", clock=h.clock.t,
                              sim={k: v for k, v in dataclasses.asdict(sim_config).items()
                                   if k in ("seed", "start_distance_m", "start_x_m", "start_heading_deg",
                                            "start_airborne", "lateral_drift", "lateral_gain", "width", "height")},
                              marker_dropout=dropout)
        with rec.recording():
            script(h, _Ops(rec, runner, mixer, h.clock, h.settings))
        return {"name": name, "description": description, "init": init, "ops": rec.ops}
    finally:
        h.close()


def _done(h: Any) -> bool:
    return h.runner.state in ("done", "aborted")


def _cl_scenarios() -> List[Tuple[str, str, Callable[[], dict]]]:
    """(group, name, builder) of every closed-loop scenario."""
    from medhop.drone.sim import SimConfig
    from medhop.drone.sim_actors import SCENARIOS
    from medhop.mission.runner import RunnerConfig
    out: List[Tuple[str, str, Callable[[], dict]]] = []

    def auto_done() -> dict:
        def script(h: Any, ops: _Ops) -> None:
            h.warm_up(1.0)
            ops.start(confirm=False, dose="d1", automatic=True)
            h.run(70.0, until=_done)
            h.run(1.5)
        return _record_closed_loop("auto_done", "automatic run from the ground: countdown, takeoff, search, approach, "
                                   "line-up, landing (tests/test_automatic.py AutomaticClosedLoopTests)",
                                   SimConfig(seed=1, start_airborne=False, start_distance_m=2.5,
                                             start_heading_deg=10.0), script)

    def manual(name: str, description: str, land: bool, assist: bool = False, dropout: float = 0.0,
               **sim: Any) -> Callable[[], dict]:
        def build() -> dict:
            def script(h: Any, ops: _Ops) -> None:
                h.warm_up(1.0)
                ops.set("land_on_arrival", land)
                if assist:
                    ops.set("drift_assist", True)
                ops.start(confirm=True, dose="d1")
                h.run(70.0, until=_done)
                h.run(0.5)
            seed = sim.pop("seed", 0)
            return _record_closed_loop(name, description, SimConfig(seed=seed, start_airborne=True, **sim), script,
                                       dropout=dropout, seed=seed)
        return build

    out.append(("runner_auto", "auto_done", auto_done))
    out.append(("runner_manual", "manual_land", manual(
        "manual_land", "manual run, land on arrival on, 0.08 m/s drift, 15 degrees off (test_sim_closed_loop.py)",
        True, seed=0, lateral_drift=0.08, start_distance_m=2.0, start_heading_deg=15.0)))
    out.append(("runner_manual", "manual_no_land", manual(
        "manual_no_land", "manual run, land on arrival off: done without the toggle", False,
        seed=2, lateral_drift=0.0, start_distance_m=1.8, start_heading_deg=-10.0)))
    out.append(("runner_manual", "assist_switches_off", manual(
        "assist_switches_off", "drift assist on, the drone answers roll the other way (lateral_gain -1): the "
        "assist switches itself off (test_sim_closed_loop.py test_i)", True, assist=True,
        seed=0, lateral_drift=0.08, start_distance_m=2.5, start_heading_deg=25.0, lateral_gain=-1.0)))
    out.append(("runner_manual", "dropout_half", manual(
        "dropout_half", "half the detections thrown away: the approach and the line-up coast through", True,
        dropout=0.5, seed=0, lateral_drift=0.0, start_distance_m=2.2, start_heading_deg=0.0)))

    def avoid_run(scenario: str, seed: int, avoid_config: Any = None) -> Callable[[], dict]:
        def build() -> dict:
            sc = SCENARIOS[scenario]
            config = SimConfig(seed=seed, start_airborne=False, start_distance_m=sc.start_distance_m or 2.5,
                               start_heading_deg=5.0 if seed % 3 == 0 else -5.0,
                               lateral_drift=0.08 if seed % 2 == 0 else -0.08, actors=sc.actors)

            def script(h: Any, ops: _Ops) -> None:
                h.warm_up(1.0)
                ops.start(confirm=False, dose="d1", automatic=True)
                h.run(150.0, until=_done)
                h.run(3.0)
            note = "" if avoid_config is None else f", blocked_timeout_s {avoid_config.blocked_timeout_s}"
            return _record_closed_loop(f"avoid_{scenario}", f"avoidance hold, automatic run, the {scenario} scenario "
                                       f"(tests/test_avoid_sim.py){note}", config, script,
                                       runner_config=RunnerConfig(avoid="hold"), avoid_config=avoid_config)
        return build

    from medhop.mission.avoid import AvoidConfig
    for scenario, seed, avoid_config in (("crossing", 0, None), ("standing", 0, AvoidConfig(blocked_timeout_s=15.0)),
                                         ("blocked", 0, AvoidConfig(blocked_timeout_s=6.0))):
        out.append(("runner_avoid", f"avoid_{scenario}", avoid_run(scenario, seed, avoid_config)))

    def cart() -> dict:
        sc = SCENARIOS["cart"]
        config = SimConfig(seed=0, start_airborne=False, start_distance_m=sc.start_distance_m, start_heading_deg=5.0,
                           lateral_drift=0.08, actors=sc.actors)

        def script(h: Any, ops: _Ops) -> None:
            h.warm_up(1.0)
            ops.blockers()
            ops.start(confirm=False, dose="d1", automatic=True)
            ops.start(confirm=True, dose="d1")
            h.run(1.0)
        return _record_closed_loop("avoid_cart", "a cart in the lane: both starts refused with obstacle_in_view",
                                   config, script, runner_config=RunnerConfig(avoid="hold"))

    out.append(("runner_quick", "avoid_cart", cart))

    def empty() -> dict:
        def script(h: Any, ops: _Ops) -> None:
            h.warm_up(1.0)
            ops.set("land_on_arrival", True)
            ops.start(confirm=True, dose="d1")
            h.run(70.0, until=_done)
            h.run(1.0)
        return _record_closed_loop("avoid_empty", "avoidance hold with nothing in the corridor, manual run",
                                   SimConfig(seed=0, start_heading_deg=0.0, start_airborne=True, lateral_drift=0.0,
                                             start_distance_m=1.6), script, runner_config=RunnerConfig(avoid="hold"))

    out.append(("runner_avoid", "avoid_empty", empty))

    def hover() -> dict:
        def script(h: Any, ops: _Ops) -> None:
            h.warm_up(1.0)
            ops.hover()
            h.run(10.5, until=lambda hh: hh.runner.state == "idle")
            h.run(0.3)
            ops.calibrate()
            ops.blockers()
        return _record_closed_loop("hover_and_calibrate", "the hover test in the simulator (0.03 m/s drift), then "
                                   "calibrate_arrival", SimConfig(seed=0, lateral_drift=0.03, start_heading_deg=0.0,
                                                                  start_airborne=True), script)

    out.append(("runner_quick", "hover_and_calibrate", hover))
    return out


class _Rig(_Ops):
    """tests/test_runner.py RunnerTestCase with every call recorded: a RecordingLink, synthetic detections
    (placeholder corners), the line-up off, arrive width 0.16, a pilot window, the clock at 1000 s."""

    def __init__(self, runner_config: Any = None, avoid_config: Any = None, **settings_kw: Any) -> None:
        from medhop.care.store import CareStore
        from medhop.mission.runner import MissionRunner, RunnerConfig
        from medhop.vision.person import PersonStatus
        from tests.harness import FakeClock, RecordingLink, make_temp_dir
        self.dir = make_temp_dir()
        clock = FakeClock(1000.0)
        settings = Settings(data_dir=self.dir, person_check="off", **{"arrive_width": 0.16, **settings_kw})
        self.inner = RecordingLink()
        self.person = PersonStatus()
        self.pilot_window = True
        rec = _RunnerRecorder(self.inner, clock, lambda: self.person, lambda: self.pilot_window)
        link = _ProxyLink(self.inner, rec)
        mixer = _spy_mixer(link, rec, clock)
        store = _RecordingStore(CareStore(self.dir, wall_clock=lambda: RUNNER_WALL_EPOCH + clock.t), rec)
        config = runner_config or RunnerConfig(align_enabled=False)
        runner = MissionRunner(link, mixer, store, settings, clock=clock, config=config,
                               wall_clock=lambda: RUNNER_WALL_EPOCH + clock.t, person_status=lambda: self.person,
                               pilot_connected=lambda: self.pilot_window, avoid_config=avoid_config)
        mixer.on_pilot_input = lambda kind: runner.abort("estop" if kind == "estop" else "pilot_took_over")
        rec.wire(runner, mixer)
        super().__init__(rec, runner, mixer, clock, settings)
        self.init = _scenario_init(settings, config, rec, store, avoid_config, kind="scripted", clock=clock.t)
        self.seq = 0

    def close(self) -> None:
        import shutil
        shutil.rmtree(self.dir, ignore_errors=True)

    def feed(self, seen: Any = None, boxes: Sequence[Tuple[str, Any]] = (), dt: float = RUNNER_DT) -> Any:
        """One frame with the marker (or not) and simulator obstacle boxes, then on every fourth frame a mixer
        tick. (tests/test_runner.py ticks on every frame; a tick changes nothing the runner reads, and the
        closed-loop scenarios tick at the mixer's own rate.)"""
        from medhop.vision.marker import MarkerObs, Observation, Obstacle
        self.clock.advance(dt)
        self.seq += 1
        self.inner.new_frame(self.clock.t)
        if seen is not None:
            seen = MarkerObs(id=seen.id, cx=seen.cx, cy=seen.cy, width=seen.width, corners=seen.corners,
                             ts=self.clock.t, height=seen.height)
        obstacles = tuple(Obstacle(kind, tuple(box), self.clock.t) for kind, box in boxes)
        self.runner.step(Observation(ts=self.clock.t, seq=self.seq, marker=seen, brightness=100.0,
                                     obstacles=obstacles), self.clock.t)
        return self.mixer.tick(self.clock.t) if self.seq % 4 == 0 else None

    def see(self, seen: Any, frames: int = 3) -> Any:
        axes = None
        for _ in range(frames):
            axes = self.feed(seen)
        return axes

    def idle(self, seconds: float, step: float = RUNNER_DT) -> Any:
        axes = None
        end = self.clock.t + seconds
        ticks = 0
        while self.clock.t < end - 1e-9:
            self.clock.advance(step)
            self.runner.step(None, self.clock.t)
            ticks += 1
            if ticks % 4 == 0:
                axes = self.mixer.tick(self.clock.t)
        return axes

    def step_none(self) -> None:
        self.runner.step(None, self.clock.t)

    def approach(self, start: float = 0.05, stop: float = 0.2, step: float = 0.004, **kw: Any) -> None:
        width = start
        while self.runner.state == "approaching" and width < stop:
            self.feed(_marker(width=width, **kw))
            width += step

    def through_takeoff(self, seen: Any = None) -> None:
        for _ in range(int(self.runner.cfg.countdown_s / RUNNER_DT) + 2):
            self.feed(seen)
        for _ in range(int(self.runner.cfg.takeoff_wait_s / RUNNER_DT) + 2):
            self.feed(seen)

    def fly_in(self, cy: float = 0.5, stop: Optional[float] = None) -> None:
        width = 0.05
        while width < 0.17 and (stop is None or width < stop):
            self.feed(_marker(width=width, cy=cy))
            width += 0.004

    def tel(self, fly: int, battery: int, flags: int, ts: float) -> None:
        from medhop.drone.base import Telemetry
        self.inner.tel = Telemetry(fly, battery, flags, ts)

    def set_person(self, **kw: Any) -> None:
        from medhop.vision.person import PersonStatus
        self.person = PersonStatus(**kw)


def _marker(cx: float = 0.5, width: float = 0.05, aspect: float = 1.0, cy: float = 0.5) -> Any:
    """tests/test_runner.py marker()."""
    from medhop.vision.marker import MarkerObs
    return MarkerObs(id=7, cx=cx, cy=cy, width=width, corners=((0, 0), (1, 0), (1, 1), (0, 1)), ts=0.0,
                     height=width / aspect)


def _person_box(distance: float, lateral: float = 0.0, width: float = 0.45, height: float = 1.7) -> Tuple[float, ...]:
    """tests/test_avoid_runner.py person_box."""
    from medhop.mission.avoid import AvoidConfig, focal_fh, focal_fw
    cfg = AvoidConfig()
    f, fh = focal_fw(cfg), focal_fh(cfg)
    box = (0.5 + (lateral - width / 2) * f / distance, 0.5 - (height - 1.0) * fh / distance,
           0.5 + (lateral + width / 2) * f / distance, 0.5 + 1.0 * fh / distance)
    return tuple(r9(max(0.0, min(1.0, v))) for v in box)


def _scripted(name: str, description: str, script: Callable[[_Rig], None], **rig_kw: Any) -> dict:
    rig = _Rig(**rig_kw)
    try:
        with rig.rec.recording():
            rig.see(_marker(width=0.05))           # RunnerTestCase.setUp
            script(rig)
        return {"name": name, "description": description, "init": rig.init, "ops": rig.rec.ops}
    finally:
        rig.close()


def _s_blockers(r: _Rig) -> None:
    """Every start blocker, the hover and calibration refusals, the setters, ready for dose."""
    r.blockers()
    r.pilot_window = False
    r.start()
    r.hover()
    r.pilot_window = True
    r.clock.advance(0.625)
    r.blockers()                                   # no_video
    r.inner.frame = None
    r.start()
    r.feed(_marker(width=0.05))
    r.pilot_estop()
    r.start()
    r.hover()
    r.estop_reset()
    r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t)
    r.start()
    r.set_person(enabled=False, detected=True, count=1, ts=r.clock.t)
    r.blockers()
    r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t - 5.0)
    r.blockers()                                   # a stale result is ignored
    r.set_person()
    r.settings_field(battery_low_raw=35)
    r.blockers()                                   # no telemetry: no decision
    r.tel(1, 35, 16, r.clock.t)
    r.start()
    r.tel(1, 36, 16, r.clock.t)
    r.blockers()
    r.tel(1, 35, 16, r.clock.t - 2.875)
    r.blockers()
    r.tel(1, 35, 16, r.clock.t - 3.0)
    r.blockers()
    r.settings_field(battery_low_raw=-1)
    r.feed(_marker(width=0.16))
    r.start()                                      # marker_too_close
    r.feed(_marker(width=0.15))
    r.start(confirm=False)                         # confirm_airborne_required
    r.tel(1, 42, 16, r.clock.t)
    r.start(confirm=False, automatic=True)         # drone_flying
    r.inner.mode = "real"
    r.blockers()
    r.feed(_marker(width=0.05))
    r.inner.mode = "sim"
    r.inner.tel = None
    r.pilot_toggle()
    r.start(confirm=False, automatic=True)         # recent_toggle
    r.clock.advance(10.5)
    r.feed(_marker(width=0.05))
    cart = ("object", _person_box(3.0, lateral=0.15, width=0.6, height=0.9))
    beside = ("object", _person_box(3.0, lateral=1.5, width=0.6, height=0.9))
    close = ("object", _person_box(2.0, lateral=1.5, width=0.6, height=0.9))
    r.feed(_marker(width=0.05), boxes=[cart])
    r.start()
    r.start(confirm=False, automatic=True)
    r.feed(_marker(width=0.05), boxes=[close])
    r.blockers()
    r.feed(_marker(width=0.05), boxes=[beside])
    r.blockers()
    r.feed(_marker(width=0.05), boxes=[("person", _person_box(3.0, lateral=1.5))])
    r.start()                                      # a simulated person anywhere in view
    r.feed(_marker(width=0.21))
    r.calibrate()
    r.feed(None)
    r.idle(0.625)
    r.calibrate()                                  # marker_not_visible
    r.hover()
    r.inner.new_frame(r.clock.t)
    r.set("avoid", "hold")
    r.set("avoid", "pass")
    r.set("drift_assist", True)
    r.set("auto_fly", True)
    r.set("land_on_arrival", True)
    r.set("drift_assist", False)
    r.ready()
    r.note()
    r.ready()
    r.see(_marker(width=0.05))
    r.start()
    r.ready()                                      # already_running
    r.start()
    r.calibrate()
    r.hover()
    r.abort()
    r.abort()                                      # nothing to stop
    r.feed(_marker(width=0.05))
    r.start(dose="d3")
    r.flush()


def _s_landings(r: _Rig) -> None:
    """Arrival and every landing outcome: sent (then the landing ends done, a pilot toggle is swallowed),
    off, refused by the mixer, settle guard undecided; pilot input and pilot link lost during the landing."""
    def settle(frames: int = 20, cy: float = 0.5) -> None:
        for _ in range(frames):
            r.feed(_marker(width=0.17, cy=cy))

    r.set("land_on_arrival", True)
    r.start(dose="d2")
    r.approach(start=0.11, step=0.01)
    settle()
    r.pilot_toggle()                               # swallowed: landing in progress
    for _ in range(int(r.runner.cfg.takeoff_wait_s / RUNNER_DT) + 2):
        r.feed(_marker(width=0.17))
    r.step_none()
    r.set("land_on_arrival", False)
    r.see(_marker(width=0.05))
    r.start()
    r.approach(start=0.11, step=0.01)
    settle()
    r.step_none()
    r.set("land_on_arrival", True)
    r.see(_marker(width=0.05))
    r.start()
    r.approach(start=0.11, step=0.01)
    r.inner.control = False                        # the landing toggle is refused by the mixer
    settle()
    r.inner.control = True
    r.step_none()
    r.see(_marker(width=0.05))
    r.start()
    r.approach(start=0.11, step=0.01)
    for cy in (None, None, 0.5, 0.5, 0.5, 0.40, 0.5, 0.40):   # sparse detections around the threshold
        for _ in range(3):
            r.feed(None)
        r.feed(None if cy is None else _marker(width=0.17, cy=cy))
    r.feed(None)
    r.feed(None)
    r.step_none()
    r.see(_marker(width=0.05))
    r.start()
    r.approach(start=0.11, step=0.01)
    settle()
    r.pilot_axes(0.0, 0.3, 0.0, 0.0)               # pilot input during the landing: done
    r.pilot_axes(0.0, 0.0, 0.0, 0.0)
    r.idle(0.5)
    r.see(_marker(width=0.05))
    r.start()
    r.approach(start=0.11, step=0.01)
    settle()
    r.abort("pilot_link_lost")                     # during the landing: done
    r.step_none()
    r.clock.advance(4.5)
    # arrival needs three in a row, 15 % growth, and counts the apparent width of a side view
    r.see(_marker(width=0.05))
    r.start()
    r.approach(stop=0.155)
    for w in (0.17, 0.17, 0.15, 0.17, 0.17, 0.17):
        r.feed(_marker(width=w))
    settle()
    r.idle(1.0)
    r.see(_marker(width=0.15))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.165))
    for _ in range(3):
        r.feed(_marker(width=0.175))
    r.abort()
    r.see(_marker(width=0.05))
    r.start()
    r.approach(stop=0.10)
    for _ in range(3):
        r.feed(_marker(width=0.14, aspect=0.85))
    r.step_none()


def _s_settle_guard(r: _Rig) -> None:
    """The settle descent guard: unexpected_descent, a marker moving down, an outlier, the reference not
    the arrival frame, the toggle waiting for a pending rise; and a marker vanishing while settling."""
    for cys in ([0.5] * 6 + [0.40] * 3, [0.5] * 6 + [0.62] * 14, [0.5] * 7 + [0.30] + [0.5] * 12, [0.40] * 20,
                [0.5] * 17 + [0.40] * 2 + [0.5], [0.5 + (0.07 if i % 2 else -0.07) for i in range(20)]):
        r.set("land_on_arrival", True)
        r.see(_marker(width=0.05))
        r.start()
        r.approach(start=0.11, step=0.01)
        for cy in cys:
            r.feed(_marker(width=0.17, cy=cy))
        r.step_none()
        r.abort()                                  # ends a landing at once (done)
        r.clock.advance(4.5)                       # past the mixer's landing guard
    r.see(_marker(width=0.05))
    r.start()
    r.approach(start=0.11, step=0.01)
    for _ in range(20):
        r.feed(None)                               # the drone dropped to the floor
    r.step_none()
    r.see(_marker(width=0.05))
    r.start()
    r.approach(start=0.11, step=0.01)
    r.pilot_axes(0.2, 0.0, 0.0, 0.0)               # pilot input while settling
    r.step_none()


def _s_aborts(r: _Rig) -> None:
    """marker_lost (hold, creep, abort), a creep that recovers, video_stale, pilot_took_over (axes, toggle,
    api), estop, person_in_view, battery_low (stale and fresh), off_axis, not_lined_up, pilot_link_lost."""
    r.start()
    for _ in range(20):
        r.feed(_marker(cx=0.62, width=0.06))
    for _ in range(int(3.0 / RUNNER_DT)):
        r.feed(None)
    r.step_none()
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(cx=0.38, width=0.06))
    for _ in range(int(1.5 / RUNNER_DT)):
        r.feed(None)
    r.feed(_marker(cx=0.45, width=0.06))
    for _ in range(10):
        r.feed(_marker(cx=0.5, width=0.06))
    for _ in range(15):
        r.feed(_marker(width=0.06))
    r.idle(0.3125)
    r.idle(1.125)
    r.idle(0.1875)                                    # video_stale
    r.inner.new_frame(r.clock.t)
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06))
    r.pilot_axes(0.0, 0.0, -0.5, 0.0)
    r.idle(0.5)
    r.pilot_axes(0.0, 0.0, 0.0, 0.0)
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06))
    r.pilot_toggle()
    r.idle(1.2)
    r.see(_marker(width=0.05))
    r.start()
    r.feed(_marker(width=0.06))
    r.abort("pilot_took_over")
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06))
    r.pilot_estop()
    r.feed(_marker(width=0.06))
    r.estop_reset()
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06))
    r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t)
    r.feed(_marker(width=0.06))
    r.set_person()
    r.settings_field(battery_low_raw=35)
    r.see(_marker(width=0.05))
    r.start()
    r.tel(1, 34, 16, r.clock.t - 3.5)
    for _ in range(10):
        r.feed(_marker(width=0.06))
    r.tel(1, 34, 16, r.clock.t)
    r.feed(_marker(width=0.06))
    r.settings_field(battery_low_raw=-1)
    r.inner.tel = None
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06))
    for _ in range(3):
        r.feed(_marker(width=0.05, aspect=0.6))    # off_axis
    r.set("land_on_arrival", True)
    r.see(_marker(width=0.05))
    r.start()
    r.approach(stop=0.15)
    for _ in range(int(3.0 / RUNNER_DT)):
        r.feed(_marker(width=0.15, aspect=0.75))   # beside the station: not_lined_up
        if r.runner.state != "approaching":
            break
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.18, cx=0.65))       # off centre at arrive size: holds, no forward stick
    for _ in range(4):
        r.feed(_marker(width=0.18, cx=0.5))
    r.abort()
    for state in ("searching", "approaching", "arrived"):
        if state == "searching":
            r.feed(None)
            r.idle(0.625)
            r.inner.new_frame(r.clock.t)
        else:
            r.see(_marker(width=0.05))
        r.start()
        if state == "arrived":
            r.approach()
        r.pilot_window = False
        r.abort("pilot_link_lost")
        r.step_none()
        r.pilot_window = True
    r.flush()


def _s_search(r: _Rig) -> None:
    """Searching: a single false detection, jumping detections, confirmation with dropout gaps, a gap
    longer than the coast; the search timeout (shortened) and the run timeout (shortened)."""
    r.feed(None)
    r.idle(0.625)
    r.inner.new_frame(r.clock.t)
    r.start()
    for index in range(30):
        r.feed(_marker(cx=0.2, cy=0.3, width=0.02) if index % 10 == 5 else None)
    for cx in (0.2, 0.5, 0.8, 0.5, 0.2):
        r.feed(_marker(cx=cx, width=0.05))
    r.feed(_marker(cx=0.9, cy=0.2, width=0.02))
    r.see(_marker(width=0.15))
    for _ in range(10):
        r.feed(_marker(width=0.165))
    r.abort()
    r.feed(None)
    r.idle(0.625)
    r.inner.new_frame(r.clock.t)
    r.start()
    for seen in (_marker(cx=0.7), None, _marker(cx=0.7), _marker(cx=0.7)):     # hit, miss, hit, hit
        r.feed(seen)
    r.abort()
    r.feed(None)
    r.idle(0.625)
    r.inner.new_frame(r.clock.t)
    r.start()
    r.feed(_marker(cx=0.7))
    for _ in range(9):
        r.feed(None)                               # longer than the coast
    r.feed(_marker(cx=0.7))
    r.feed(_marker(cx=0.7))
    for _ in range(int(4.5 / RUNNER_DT)):
        r.feed(None)                               # marker_not_found (search_timeout_s 4)
    r.step_none()
    r.see(_marker(width=0.15))
    r.start()
    for _ in range(int(7.0 / RUNNER_DT)):
        r.feed(_marker(width=0.165))               # never grows enough: timeout (run_timeout_s 6)
    r.step_none()


def _s_coast(r: _Rig) -> None:
    """Detection dropouts in the approach (tests/test_runner.py DropoutCoastTests)."""
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06))
    r.feed(None)
    for _ in range(3):
        r.feed(_marker(width=0.06))
    for _ in range(12):
        r.feed(None)                               # fades, then neutral, then creeps
    r.feed(_marker(width=0.06))
    for _ in range(5):
        r.feed(_marker(width=0.06))
    width = 0.06
    while width < 0.15:
        r.feed(_marker(width=width))
        width += 0.006
    r.feed(None)                                   # near the arrive width: no forward coast
    for w in (0.17, None, 0.17, 0.17):              # the arrival counts survive a dropout
        r.feed(None if w is None else _marker(width=w))
    r.abort()
    r.idle(0.5)
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06))
    r.feed(None)
    r.pilot_estop()                                # an e-stop during a coast
    r.feed(None)
    r.estop_reset()


def _s_automatic(r: _Rig) -> None:
    """Automatic runs (tests/test_automatic.py): countdown, takeoff, landing on arrival; Stop in the
    countdown; takeoff refused; a safe landing after a confirmed flight; no landing when the marker rises,
    is lost, or before the flight is confirmed; estop and pilot take-over never toggle; already at the
    station; the rise allowed scales with the distance."""
    r.start(confirm=False, dose="d1", automatic=True)
    for _ in range(int(r.runner.cfg.countdown_s / RUNNER_DT) + 2):
        r.feed(_marker(width=0.05))
    for _ in range(int(r.runner.cfg.takeoff_wait_s / RUNNER_DT) + 2):
        r.feed(_marker(width=0.05))
    r.fly_in()
    for _ in range(30):
        r.feed(_marker(width=0.17))
    for _ in range(int(r.runner.cfg.takeoff_wait_s / RUNNER_DT) + 2):
        r.feed(_marker(width=0.17))
    r.clock.advance(11.0)
    r.feed(_marker(width=0.05))
    r.start(confirm=False, automatic=True)
    r.feed(_marker(width=0.05))
    r.abort("pilot_took_over")                     # Stop during the countdown: never flies
    r.feed(_marker(width=0.05))
    r.start(confirm=False, automatic=True)
    r.inner.control = False
    for _ in range(int(r.runner.cfg.countdown_s / RUNNER_DT) + 2):
        r.feed(_marker(width=0.05))                # takeoff_refused
    r.inner.control = True
    r.clock.advance(11.0)
    r.feed(_marker(width=0.05))
    r.start(confirm=False, automatic=True)
    r.through_takeoff(_marker(width=0.05))
    r.fly_in(stop=0.10)
    r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t)
    r.feed(_marker(width=0.10))                    # safe landing
    r.set_person()
    r.clock.advance(11.0)
    r.feed(_marker(width=0.05))
    r.start(confirm=False, automatic=True)
    r.through_takeoff(_marker(width=0.05))
    r.fly_in(stop=0.10)
    for i in range(12):
        r.feed(_marker(width=0.10, cy=0.5 - 0.02 * i))
    r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t)
    r.feed(_marker(width=0.10, cy=0.25))           # rising: no landing, needs a pilot
    r.set_person()
    r.note()
    r.clock.advance(11.0)
    r.feed(_marker(width=0.05))
    r.start(confirm=False, automatic=True)
    r.through_takeoff(_marker(width=0.05))
    r.fly_in(stop=0.10)
    for _ in range(int(3.0 / RUNNER_DT)):
        r.feed(None)                               # marker_lost: no landing
    r.clock.advance(11.0)
    r.feed(_marker(width=0.05))
    r.start(confirm=False, automatic=True)
    r.through_takeoff()
    r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t)
    r.feed(None)                                   # not confirmed: no landing
    r.set_person()
    for reason in ("estop", "pilot_took_over"):
        r.clock.advance(11.0)
        r.estop_reset()
        r.feed(_marker(width=0.05))
        r.start(confirm=False, automatic=True)
        r.through_takeoff(_marker(width=0.05))
        for _ in range(4):
            r.feed(_marker(width=0.05))
        if reason == "estop":
            r.pilot_estop()
        else:
            r.abort("pilot_took_over")
        r.feed(_marker(width=0.10))
    r.estop_reset()
    r.clock.advance(11.0)
    r.feed(_marker(width=0.05))
    r.start(confirm=False, automatic=True)
    for _ in range(int(r.runner.cfg.countdown_s / RUNNER_DT) + 2):
        r.feed(None)
    for _ in range(int(r.runner.cfg.takeoff_wait_s / RUNNER_DT) + 2):
        r.feed(_marker(width=0.17))                # already_at_station
    r.ready()
    r.flush()


def _s_safe_landing_scale(r: _Rig, width: float, rise: float) -> None:
    """The rise allowed for a safe landing scales with the current distance (test_automatic.py: a 0.11
    rise far away is a real sink, close to the sign it still lands)."""
    for _ in range(1):
        r.start(confirm=False, automatic=True)
        r.through_takeoff(_marker(width=0.05))
        w = 0.05
        while w < width:
            r.feed(_marker(width=w))
            w += 0.004
        for _ in range(int(2.2 / RUNNER_DT)):
            r.feed(_marker(width=width))
        r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t)
        r.feed(_marker(width=width, cy=0.5 - rise))
        r.set_person()


def _s_avoid(r: _Rig) -> None:
    """Avoidance in the runner with synthetic boxes (tests/test_avoid_runner.py): in-flight holds for an
    object and a person-check box, a stale check, the sign hidden (not lost), a box over where the sign
    was, searching again at most twice, the run keeping its mode, the status shapes, a countdown stopped
    by a person and by an object."""
    r.start()
    for _ in range(5):
        r.feed(_marker(width=0.06))
    for _ in range(10):
        r.feed(_marker(width=0.06), boxes=[("object", _person_box(2.0, height=0.9))])
    r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t, boxes=(_person_box(2.0),))
    for _ in range(10):
        r.feed(_marker(width=0.06))
    r.set_person(enabled=True, detected=True, count=1, ts=r.clock.t - 5.0, boxes=(_person_box(2.0),))
    for _ in range(25):
        r.feed(_marker(width=0.06))                # stale: no evidence; clears after a second
    r.set_person()
    r.set("avoid", "off")
    r.feed(_marker(width=0.06), boxes=[("person", _person_box(2.0))])   # the run keeps "hold"
    r.set("avoid", "hold")
    for _ in range(int(10.0 / RUNNER_DT)):
        r.feed(None, boxes=[("person", _person_box(2.0))])                 # hidden for 10 s, not lost
    for _ in range(int(1.5 / RUNNER_DT)):
        r.feed(_marker(width=0.06))
    r.abort()
    r.see(_marker(width=0.05))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06, cx=0.8))
    # corners spanning (0.75, 0.45) to (0.85, 0.55) of the frame (the Python test sets that box directly)
    boxed = _marker(width=0.1, cx=0.8)
    boxed = type(boxed)(id=7, cx=0.8, cy=0.5, width=0.1, corners=((480.0, 162.0), (544.0, 162.0), (544.0, 198.0),
                                                                   (480.0, 198.0)), ts=0.0, height=0.1)
    for _ in range(3):
        r.feed(boxed)
    for _ in range(int(3.0 / RUNNER_DT)):
        r.feed(None, boxes=[("person", (0.7, 0.3, 0.95, 0.7))])
    r.abort()
    r.see(_marker(width=0.05, cx=0.3))
    r.start()
    for _ in range(10):
        r.feed(_marker(width=0.06, cx=0.3))
    for attempt in range(3):
        for _ in range(int(2.0 / RUNNER_DT)):
            r.feed(None, boxes=[("person", _person_box(2.0))])
        for _ in range(int(2.0 / RUNNER_DT)):
            r.feed(None)
        if attempt < 2:
            for _ in range(4):
                r.feed(_marker(width=0.06, cx=0.3))
    r.step_none()
    r.see(_marker(width=0.06))
    r.start()
    r.feed(_marker(width=0.06), boxes=[("person", _person_box(3.2, lateral=0.2)),
                                       ("object", _person_box(2.0, lateral=-1.5, height=0.9))])
    r.abort()
    for kind in ("person", "object"):
        r.clock.advance(11.0)
        r.feed(_marker(width=0.05))
        r.start(confirm=False, automatic=True)
        r.feed(None)
        r.feed(None, boxes=[(kind, _person_box(3.0))])
    r.flush()


def _s_path_blocked(r: _Rig) -> None:
    """path_blocked (blocked_timeout_s 4 here): a manual run (time held not counted against the run timeout,
    run_timeout_s 10), an automatic run landing on the obstacle's evidence, no landing when the obstacle
    rises in the picture, a climb seen during the takeoff as evidence, and without that climb."""
    r.start()
    for _ in range(int(7.0 / RUNNER_DT)):
        r.feed(_marker(width=0.06))
    for _ in range(int(5.0 / RUNNER_DT)):
        r.feed(_marker(width=0.06), boxes=[("person", _person_box(2.0))])
        if r.runner.state != "approaching":
            break
    r.step_none()

    def automatic_into_hold() -> None:
        r.clock.advance(11.0)
        r.feed(_marker(width=0.05))
        r.start(confirm=False, automatic=True)
        for _ in range(int(r.runner.cfg.countdown_s / RUNNER_DT) + 2 + int(r.runner.cfg.takeoff_wait_s / RUNNER_DT) + 2):
            r.feed(_marker(width=0.05))
        width = 0.05
        while width < 0.08:
            r.feed(_marker(width=width))
            width += 0.003

    automatic_into_hold()
    for _ in range(int(6.0 / RUNNER_DT)):
        if r.runner.state != "approaching":
            break
        r.feed(None, boxes=[("person", _person_box(2.0))])
    automatic_into_hold()
    x1, y1, x2, y2 = _person_box(2.0)
    sinking_from = int(2.5 / RUNNER_DT)            # from 1.5 s before the 4 s limit to past the 2.5 s wait
    for i in range(int(10.0 / RUNNER_DT)):
        if r.runner.state != "approaching":
            break
        rise = max(0.0, (i - sinking_from) * 0.006)
        r.feed(None, boxes=[("person", (x1, y1 - rise, x2, y2 - rise))])
    for ground_cy in (0.21, 0.45):
        r.clock.advance(11.0)
        r.feed(_marker(width=0.05))
        r.start(confirm=False, automatic=True)
        for _ in range(int(r.runner.cfg.countdown_s / RUNNER_DT) + 2):
            r.feed(_marker(width=0.05, cy=ground_cy))
        for _ in range(int(r.runner.cfg.takeoff_wait_s / RUNNER_DT) + 2):
            r.feed(_marker(width=0.05, cy=0.50))
        for _ in range(int(9.0 / RUNNER_DT)):
            if r.runner.state in ("aborted", "done"):
                break
            r.feed(None, boxes=[("person", _person_box(2.0))])
    r.clock.advance(11.0)
    r.feed(_marker(width=0.05))
    r.start(confirm=False, automatic=True)
    for _ in range(int(r.runner.cfg.countdown_s / RUNNER_DT) + 2):
        r.feed(_marker(width=0.05, cy=0.21))
    for _ in range(int(r.runner.cfg.takeoff_wait_s / RUNNER_DT) + 2):
        r.feed(_marker(width=0.05, cy=0.50))
    r.abort("timeout")                             # the climb counts for path_blocked only
    r.flush()


def _s_hover(r: _Rig) -> None:
    """The hover test (tests/test_runner.py HoverTestTests): a drift that fails on the peak excursion, low
    visibility, the trim during the test, cancelled by pilot input, by the pilot link and by the e-stop."""
    frames = int(10.0 / RUNNER_DT) + 2

    def run(cx_at: Callable[[float], float], visible: Callable[[int], bool] = lambda i: True) -> None:
        r.hover()
        for i in range(frames):
            r.feed(_marker(cx=cx_at(i / frames), width=0.05) if visible(i) else None)
            if r.runner.state != "hover_test":
                break

    run(lambda f: 0.5 + 0.2 * (1.0 - abs(2.0 * f - 1.0)))
    r.settings_field(hover_max_excursion_m=0.8)
    run(lambda f: 0.6 - 0.2 * f, visible=lambda i: i % 4 != 0)
    r.set_trim(0.03, -0.01)
    r.hover()
    for _ in range(10):
        r.feed(_marker())
    r.pilot_axes(0.0, 0.0, 0.0, 0.4)
    r.idle(0.5)
    r.pilot_axes(0.0, 0.0, 0.0, 0.0)
    r.feed(_marker())
    r.hover()
    r.feed(_marker())
    r.abort("pilot_link_lost")
    r.step_none()
    r.hover()
    r.feed(_marker())
    r.pilot_estop()
    r.feed(_marker())
    r.estop_reset()
    r.flush()


def _scripted_scenarios() -> List[Tuple[str, str, Callable[[], dict]]]:
    from medhop.mission.avoid import AvoidConfig
    from medhop.mission.runner import RunnerConfig
    plain = RunnerConfig(align_enabled=False)
    # automatic runs with a 2 s countdown and a 2 s takeoff wait (the defaults are 5 s and 4 s)
    quick_auto = dataclasses.replace(plain, countdown_s=2.0, takeoff_wait_s=2.0)
    return [
        ("runner_scripted", "blockers", lambda: _scripted("blockers", _s_blockers.__doc__, _s_blockers)),
        ("runner_scripted", "landings", lambda: _scripted("landings", _s_landings.__doc__, _s_landings)),
        ("runner_scripted", "settle_guard", lambda: _scripted("settle_guard", _s_settle_guard.__doc__, _s_settle_guard)),
        ("runner_scripted", "aborts", lambda: _scripted("aborts", _s_aborts.__doc__, _s_aborts)),
        ("runner_scripted", "search", lambda: _scripted(
            "search", _s_search.__doc__, _s_search,
            runner_config=dataclasses.replace(plain, search_timeout_s=4.0, run_timeout_s=6.0))),
        ("runner_scripted", "coast", lambda: _scripted("coast", _s_coast.__doc__, _s_coast)),
        ("runner_scripted", "automatic", lambda: _scripted(
            "automatic", _s_automatic.__doc__, _s_automatic, runner_config=quick_auto)),
        ("runner_scripted", "safe_landing_far", lambda: _scripted(
            "safe_landing_far", _s_safe_landing_scale.__doc__, lambda r: _s_safe_landing_scale(r, 0.064, 0.11),
            arrive_width=0.2856)),
        ("runner_scripted", "safe_landing_close", lambda: _scripted(
            "safe_landing_close", _s_safe_landing_scale.__doc__, lambda r: _s_safe_landing_scale(r, 0.286, 0.11),
            arrive_width=0.32)),
        ("runner_scripted", "avoid", lambda: _scripted(
            "avoid", _s_avoid.__doc__, _s_avoid, runner_config=dataclasses.replace(plain, avoid="hold"))),
        ("runner_scripted", "path_blocked", lambda: _scripted(
            "path_blocked", _s_path_blocked.__doc__, _s_path_blocked,
            runner_config=dataclasses.replace(quick_auto, avoid="hold", run_timeout_s=10.0),
            avoid_config=AvoidConfig(blocked_timeout_s=4.0))),
        ("runner_scripted", "hover", lambda: _scripted("hover", _s_hover.__doc__, _s_hover)),
    ]


def _runner_scenarios() -> List[Tuple[str, str, Callable[[], dict]]]:
    return [*_scripted_scenarios(), *_cl_scenarios()]


def build_runner_scenario(name: str) -> dict:
    """One runner scenario by name (tests/test_parity_fixtures.py regenerates some on their own)."""
    for _group, scenario, builder in _runner_scenarios():
        if scenario == name:
            return encode(builder())
    raise KeyError(name)


def _runner_group(group: str) -> Callable[[], dict]:
    def build() -> dict:
        from medhop.mission.runner import ABORT_REASONS, BLOCKERS, SAFE_LANDING_REASONS, RunnerConfig
        return {"wall_epoch": RUNNER_WALL_EPOCH,
                "constants": {"ABORT_REASONS": list(ABORT_REASONS), "BLOCKERS": list(BLOCKERS),
                              "SAFE_LANDING_REASONS": sorted(SAFE_LANDING_REASONS),
                              "runner_config": dataclasses.asdict(RunnerConfig())},
                "scenarios": [builder() for g, _name, builder in _runner_scenarios() if g == group]}
    return build


# ---------------------------------------------------------------------------------------------- #
# command line

GROUPS: Dict[str, Callable[[], dict]] = {
    "steering": build_steering,
    "pose": build_pose,
    "mixer": build_mixer,
    "num": build_num,
    "rng": build_rng,
    "config": build_config,
    "sim_physics": build_sim_physics,
    "sim_actors": build_sim_actors,
    "projection": build_projection,
    "sim_harness": build_sim_harness,
    "marker7": build_marker7,
    "avoid": build_avoid,
    # the scripted runner scenarios and two short closed-loop ones: a few seconds, so they are checked here
    "runner_scripted": _runner_group("runner_scripted"),
    "runner_quick": _runner_group("runner_quick"),
}
# Measured, not replayed: renders pictures and runs the real detector (about a minute). Its `cases`
# part is deterministic and is what tests/test_parity_fixtures.py regenerates (build_detector_cases).
MEASURED_GROUPS: Dict[str, Callable[[], dict]] = {
    "detector_calibration": build_detector_calibration,
}
# The mission runner's closed-loop traces: replayed, but each records simulator runs with rendering and
# the real detector (several seconds each), so tests/test_parity_fixtures.py does not regenerate them
# (it does regenerate runner_scripted and runner_quick, which are in GROUPS). `replayed` and `all`
# include them.
RUNNER_GROUPS: Dict[str, Callable[[], dict]] = {name: _runner_group(name)
                                                for name in ("runner_auto", "runner_manual", "runner_avoid")}
ALL_GROUPS: Dict[str, Callable[[], dict]] = {**GROUPS, **RUNNER_GROUPS, **MEASURED_GROUPS}


def fixture_path(name: str, out_dir: Path = FIXTURE_DIR) -> Path:
    return out_dir / f"{name}.json"


def build_group(name: str) -> dict:
    """The group's data as written to its file (plain JSON values)."""
    return encode({"group": name, "generator": f"backend/tools/parity_traces.py {name}", **ALL_GROUPS[name]()})


def render_group(data: dict) -> str:
    # runner groups: {"scenarios": [{"ops": [op, ...]}]}: an op sits at depth 4, one per line
    flat_from = 4 if str(data.get("group", "")).startswith("runner_") else None
    return render(data, flat_from=flat_from) + "\n"


def load_fixture_text(text: str) -> dict:
    """Parse a rendered group back into Python values (NaN and the infinities restored)."""
    return json.loads(text, object_hook=decode_floats)


def load_fixture(path: Path) -> dict:
    return load_fixture_text(path.read_text(encoding="utf-8"))


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("groups", nargs="+", choices=[*ALL_GROUPS, "all", "replayed"],
                        help="fixture groups; all (every group), or replayed (all but the measured ones)")
    parser.add_argument("--check", action="store_true", help="compare with the files instead of writing them")
    parser.add_argument("--out-dir", type=Path, default=FIXTURE_DIR)
    args = parser.parse_args(argv)
    if "all" in args.groups:
        names = list(ALL_GROUPS)
    elif "replayed" in args.groups:
        names = [*GROUPS, *RUNNER_GROUPS]
    else:
        names = list(dict.fromkeys(args.groups))
    if any(name in MEASURED_GROUPS for name in names):
        print("detector_calibration renders and detects about 1400 frames: this takes a minute", file=sys.stderr)
    stale = []
    for name in names:
        text = render_group(build_group(name))
        path = fixture_path(name, args.out_dir)
        if args.check:
            same = path.exists() and path.read_text(encoding="utf-8") == text
            print(f"{'ok   ' if same else 'STALE'} {path} ({len(text)} bytes)")
            if not same:
                stale.append(name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        print(f"wrote {path} ({len(text)} bytes)")
    if stale:
        print(f"regenerate with: python tools/parity_traces.py {' '.join(stale)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
