#!/usr/bin/env python3
"""Record reference traces from the Python flight logic, for the TypeScript port in frontend/src/engine.

    python tools/parity_traces.py all              # rewrite every fixture group
    python tools/parity_traces.py steering pose    # only these groups
    python tools/parity_traces.py --check all      # compare with the committed files, write nothing

Groups: steering (mission/steering.py), pose (vision/pose.py), mixer (mixer.py, driven through the
RecordingLink of tests/harness.py), num (the Python number semantics the port mirrors: round, hypot,
sum, median, repr, clamp), rng (random.Random), config (Settings and the config dataclass defaults).

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


def render(value: Any, indent: int = 0, width: int = 118) -> str:
    """Compact JSON, broken into one item per line wherever a line would get long (diff-friendly)."""
    flat = json.dumps(value, separators=(",", ":"), allow_nan=False)
    if len(flat) + indent <= width or not isinstance(value, (list, dict)) or not value:
        return flat
    pad = " " * (indent + 1)
    if isinstance(value, list):
        inner = ",\n".join(pad + render(item, indent + 1, width) for item in value)
        return "[\n" + inner + "\n" + " " * indent + "]"
    inner = ",\n".join(pad + json.dumps(key) + ":" + render(item, indent + 1, width) for key, item in value.items())
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
                   "camera_hfov_deg", "sim_camera")
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
                 {"arrive_width": 0.02}):
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
# command line

GROUPS: Dict[str, Callable[[], dict]] = {
    "steering": build_steering,
    "pose": build_pose,
    "mixer": build_mixer,
    "num": build_num,
    "rng": build_rng,
    "config": build_config,
}


def fixture_path(name: str, out_dir: Path = FIXTURE_DIR) -> Path:
    return out_dir / f"{name}.json"


def build_group(name: str) -> dict:
    """The group's data as written to its file (plain JSON values)."""
    return encode({"group": name, "generator": f"backend/tools/parity_traces.py {name}", **GROUPS[name]()})


def render_group(data: dict) -> str:
    return render(data) + "\n"


def load_fixture_text(text: str) -> dict:
    """Parse a rendered group back into Python values (NaN and the infinities restored)."""
    return json.loads(text, object_hook=decode_floats)


def load_fixture(path: Path) -> dict:
    return load_fixture_text(path.read_text(encoding="utf-8"))


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("groups", nargs="+", choices=[*GROUPS, "all"], help="fixture groups, or all")
    parser.add_argument("--check", action="store_true", help="compare with the files instead of writing them")
    parser.add_argument("--out-dir", type=Path, default=FIXTURE_DIR)
    args = parser.parse_args(argv)
    names = list(GROUPS) if "all" in args.groups else list(dict.fromkeys(args.groups))
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
