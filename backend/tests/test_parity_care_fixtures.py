"""The care port's reference cases (frontend/src/engine/care/__fixtures__) match the Python.

tools/parity_care.py records cases from medhop/care/status.py and medhop/care/store.py; the vitest suites
under frontend/src/engine/care replay them through the TypeScript port. These tests regenerate both
groups in memory and compare them with the committed files, so a change to the care code that is not
followed by `python tools/parity_care.py` fails here.

Every value in these fixtures is a string, a boolean, None, an integer or a float that was recorded
from a literal (trim values, widths, local-time seconds such as 0.5), and every time is written as local
calendar components, so the regenerated text must equal the committed text exactly, in any time zone.
One test regenerates the files in a subprocess with another time zone to check exactly that.
"""
import os
import subprocess
import sys
import unittest
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import parity_care  # noqa: E402

MAX_TOTAL_BYTES = 400_000


def first_difference(committed: str, regenerated: str) -> str:
    a, b = committed.splitlines(), regenerated.splitlines()
    for number, (x, y) in enumerate(zip(a, b), start=1):
        if x != y:
            return f"line {number}:\n  committed   {x[:200]}\n  regenerated {y[:200]}"
    return f"committed {len(a)} lines, regenerated {len(b)} lines"


class CareParityFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rendered = {name: parity_care.render_group(parity_care.build_group(name)) for name in parity_care.GROUPS}

    def test_every_group_matches_its_committed_file(self):
        for name, text in self.rendered.items():
            with self.subTest(group=name):
                path = parity_care.fixture_path(name)
                self.assertTrue(path.exists(), f"{path} is missing: run python tools/parity_care.py")
                committed = path.read_bytes().decode("utf-8")
                self.assertTrue(committed == text,
                                f"{name}.json is out of date with the Python ({first_difference(committed, text)}); "
                                f"regenerate with python tools/parity_care.py")

    def test_the_generator_is_deterministic(self):
        # care_status holds the random cases; care_store is rebuilt by the time zone test below
        self.assertEqual(self.rendered["care_status"], parity_care.render_group(parity_care.build_group("care_status")))

    def test_the_fixtures_do_not_depend_on_the_time_zone(self):
        """Regenerate in a zone far from this machine's and compare with the committed files."""
        env = dict(os.environ, TZ="JST-9" if os.environ.get("TZ") != "JST-9" else "UTC0", PYTHONIOENCODING="utf-8")
        result = subprocess.run([sys.executable, str(TOOLS_DIR / "parity_care.py"), "--check"], env=env,
                                capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_the_fixtures_stay_small(self):
        total = sum(parity_care.fixture_path(name).stat().st_size for name in parity_care.GROUPS)
        self.assertLessEqual(total, MAX_TOTAL_BYTES)

    def test_avoid_is_only_recorded_with_off_hold_and_an_invalid_value(self):
        steps = [step for scenario in parity_care.load_fixture("care_store")["scenarios"] for step in scenario["steps"]]
        modes = {step["args"][0] for step in steps if step["op"] == "save_avoid"}
        self.assertTrue({"off", "hold", "sideways"} <= modes, modes)
        self.assertNotIn("pass", modes)

    def test_local_time_helpers_round_trip(self):
        for fields in ([2026, 11, 11, 8, 0, 0], [2026, 12, 31, 23, 59, 59.5], [2027, 1, 1, 0, 0, 0]):
            self.assertEqual(parity_care.fields_of(parity_care.ts_of(fields)), fields)
        text = '{"ts": {{2026,11,11,8,0,0}}}'
        self.assertEqual(parity_care.untemplate(parity_care.fill(text)), text)


if __name__ == "__main__":
    unittest.main()
