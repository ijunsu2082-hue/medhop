"""The TypeScript port's reference traces (frontend/src/engine/__fixtures__) match the Python.

tools/parity_traces.py records traces from mission/steering.py, vision/pose.py and mixer.py (and from
the Python number semantics they rely on), and from the simulator: drone/sim.py stepped with its noise
at zero, drone/sim_actors.py, the camera, and SimHarness.step of tests/harness.py. The vitest suites
under frontend/src/engine replay them through the TypeScript port. These tests regenerate every
replayed group in memory and compare it with the committed file, so a change to the Python that is not
followed by `python tools/parity_traces.py replayed` fails here. detector_calibration is measured, not
replayed (it renders pictures and runs the real detector for about a minute): only its deterministic
`cases` part is regenerated here.

Comparison: strings, booleans, None and integers exactly; floats within 1e-9 relative or 1e-12
absolute (the same machine reproduces them bit for bit; another machine's C library or OpenBLAS may
round differently). Pose fits use the rule of the vitest suite: within the tolerance, or within 16
times the recorded one-ulp spread of Python's own answer. The `spread` and `stopped_by_rule` entries
describe how stable that answer is and are not compared themselves.
"""
import math
import sys
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import parity_traces  # noqa: E402

REL, ABS = 1e-9, 1e-12
SPREAD_FACTOR = 16.0        # as in frontend/src/engine/vision/pose.test.ts
MAX_TOTAL_BYTES = 1_500_000             # the flight-logic groups
SIMULATOR_GROUPS = ("sim_physics", "sim_actors", "projection", "sim_harness", "detector_calibration")
MAX_SIMULATOR_BYTES = 1_500_000         # the simulator groups, on top
INFORMATIONAL_KEYS = ("spread", "stopped_by_rule")


def floats_close(a: float, b: float, allowance: float = 0.0) -> bool:
    if math.isnan(a) or math.isnan(b):
        return math.isnan(a) and math.isnan(b)
    if a == b:
        return True
    if not (math.isfinite(a) and math.isfinite(b)):
        return False
    diff = abs(a - b)
    return diff <= ABS or diff <= REL * max(abs(a), abs(b)) or diff <= allowance


def compare(actual, expected, path, problems, allowance=None):
    """Append a description of every difference to `problems`."""
    if len(problems) > 20:
        return
    if isinstance(expected, bool) or expected is None or isinstance(expected, str):
        if type(actual) is not type(expected) or actual != expected:
            problems.append(f"{path}: committed {expected!r}, regenerated {actual!r}")
        return
    if isinstance(expected, int):
        if type(actual) is not int or actual != expected:
            problems.append(f"{path}: committed {expected!r}, regenerated {actual!r}")
        return
    if isinstance(expected, float):
        extra = 0.0 if allowance is None else allowance
        if type(actual) is not float or not floats_close(actual, expected, extra):
            problems.append(f"{path}: committed {expected!r}, regenerated {actual!r}")
        return
    if isinstance(expected, list):
        if not isinstance(actual, list) or len(actual) != len(expected):
            problems.append(f"{path}: committed a list of {len(expected)}, regenerated {type(actual).__name__}"
                            f"{'' if not isinstance(actual, list) else f' of {len(actual)}'}")
            return
        for i, (a, e) in enumerate(zip(actual, expected)):
            compare(a, e, f"{path}[{i}]", problems)
        return
    if isinstance(expected, dict):
        if not isinstance(actual, dict) or sorted(actual) != sorted(expected):
            problems.append(f"{path}: keys differ: committed {sorted(expected)}, regenerated "
                            f"{sorted(actual) if isinstance(actual, dict) else type(actual).__name__}")
            return
        if "spread" in expected and "out" in expected:      # a pose fit case
            spread = expected["spread"] or {}
            out_a, out_e = actual["out"], expected["out"]
            if (out_a is None) != (out_e is None):
                problems.append(f"{path}.out: committed {out_e!r}, regenerated {out_a!r}")
            elif out_e is not None:
                for key, value in out_e.items():
                    compare(out_a[key], value, f"{path}.out.{key}", problems, SPREAD_FACTOR * spread.get(key, 0.0))
            for key in expected:
                if key not in ("out",) + INFORMATIONAL_KEYS:
                    compare(actual[key], expected[key], f"{path}.{key}", problems)
            return
        for key in expected:
            compare(actual[key], expected[key], f"{path}.{key}", problems)
        return
    problems.append(f"{path}: unexpected committed value {expected!r}")


class ParityFixtureTests(unittest.TestCase):
    def test_every_group_matches_its_committed_file(self):
        for name in parity_traces.GROUPS:
            with self.subTest(group=name):
                path = parity_traces.fixture_path(name)
                self.assertTrue(path.exists(), f"{path} is missing: run python tools/parity_traces.py {name}")
                committed = parity_traces.load_fixture(path)
                regenerated = parity_traces.load_fixture_text(
                    parity_traces.render_group(parity_traces.build_group(name)))
                problems = []
                compare(regenerated, committed, name, problems)
                self.assertEqual(problems, [], f"{name}.json is out of date with the Python; regenerate with "
                                               f"python tools/parity_traces.py {name}")

    def test_the_generator_is_deterministic(self):
        for name in ("mixer", "config"):
            with self.subTest(group=name):
                first = parity_traces.render_group(parity_traces.build_group(name))
                self.assertEqual(first, parity_traces.render_group(parity_traces.build_group(name)))

    def test_the_detector_calibration_cases_match(self):
        path = parity_traces.fixture_path("detector_calibration")
        self.assertTrue(path.exists(), f"{path} is missing: run python tools/parity_traces.py detector_calibration")
        committed = parity_traces.load_fixture(path)
        regenerated = parity_traces.load_fixture_text(
            parity_traces.render(parity_traces.encode(parity_traces.build_detector_cases())))
        problems = []
        compare(regenerated, committed["cases"], "detector_calibration.cases", problems)
        self.assertEqual(problems, [], "detector_calibration.json is out of date with the Python; measure again with "
                                       "python tools/parity_traces.py detector_calibration")
        self.assertEqual([m["profile"] for m in committed["measured"]], ["high", "drone"])

    def test_the_fixtures_stay_small(self):
        sizes = {name: parity_traces.fixture_path(name).stat().st_size for name in parity_traces.ALL_GROUPS}
        self.assertEqual(set(SIMULATOR_GROUPS) - set(sizes), set())
        self.assertLessEqual(sum(v for k, v in sizes.items() if k not in SIMULATOR_GROUPS), MAX_TOTAL_BYTES)
        self.assertLessEqual(sum(sizes[k] for k in SIMULATOR_GROUPS), MAX_SIMULATOR_BYTES)

    def test_the_comparison_notices_a_change(self):
        problems = []
        compare({"a": [1, 0.5, "x", None]}, {"a": [1, 0.5000001, "x", None]}, "t", problems)
        self.assertEqual(len(problems), 1)
        problems = []
        compare({"a": 1.0}, {"a": 1}, "t", problems)          # a float where Python gave an int
        self.assertEqual(len(problems), 1)
        problems = []
        compare([float("nan"), 2.0 + 1e-13], [float("nan"), 2.0], "t", problems)
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
