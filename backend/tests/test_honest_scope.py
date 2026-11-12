"""Honest scope (SPEC section 1) as a check on the backend's own words.

Every string the backend can show, log or store comes from the source files under medhop/ and tools/,
so those files are scanned: no claim of a hand-over, the advisory person check is never presented as
a safety system or an interlock, and marker detection (ArUco, classical computer vision) is never
called AI. tests/test_api.py checks the same on what the running API actually returns.
"""
import re
import unittest
from pathlib import Path

from medhop.care.store import EVENT_TYPES
from medhop.mission.runner import ABORT_REASONS, BLOCKERS, MARKER_NOT_VISIBLE, NOT_CONFIRMED, STATES
from medhop.mission.steering import DISABLED_OFF_AXIS

BACKEND = Path(__file__).resolve().parents[1]
SOURCES = sorted(list((BACKEND / "medhop").rglob("*.py")) + list((BACKEND / "tools").glob("*.py")))
TESTS = sorted((BACKEND / "tests").glob("test_*.py"))

HAND_OVER = re.compile(r"deliver", re.IGNORECASE)                       # "delivered", "delivery", ...
# The only exceptions: SPEC 10.4 names the emergency stop's motor-cut confirmation this way (the status
# key, the field of the estop ack, and the e-stop banner text). None of them is about medicine.
ESTOP_WORDING = ("estop_delivered", '"of": "estop", "delivered"', "NOT delivered yet")


def without_estop_wording(line):
    for allowed in ESTOP_WORDING:
        line = line.replace(allowed, "")
    return line
STRONG_CLAIM = re.compile(r"interlock|safety[ -]system", re.IGNORECASE)
DENIAL = re.compile(r"\b(not|never|no)\b", re.IGNORECASE)


def lines_of(path):
    return list(enumerate(path.read_text(encoding="utf-8").splitlines(), start=1))


class SourceWordingTests(unittest.TestCase):
    def test_the_scan_sees_the_new_files(self):
        names = {path.name for path in SOURCES}
        self.assertTrue({"runner.py", "steering.py", "mixer.py", "status.py", "person.py", "worker.py",
                         "server.py", "eval_person_check.py"} <= names, names)

    def test_no_source_line_claims_a_hand_over(self):
        for path in SOURCES:
            for number, line in lines_of(path):
                self.assertIsNone(HAND_OVER.search(without_estop_wording(line)), f"{path.name}:{number}: {line.strip()}")

    def test_safety_system_and_interlock_are_never_claimed_only_denied(self):
        seen = 0
        for path in SOURCES:
            for number, line in lines_of(path):
                if STRONG_CLAIM.search(line):
                    seen += 1
                    self.assertIsNotNone(DENIAL.search(line), f"{path.name}:{number}: {line.strip()}")
        self.assertGreaterEqual(seen, 1, "the person check's module is expected to say what it is not")

    def test_ai_is_only_mentioned_to_say_that_marker_detection_is_not_ai(self):
        for path in SOURCES:
            for number, line in lines_of(path):
                # the word itself, in capitals: "AI" (not "ai" inside other words or names)
                if re.search(r"\bAI\b", line) or re.search(r"artificial intelligence", line, re.IGNORECASE):
                    self.assertIsNotNone(DENIAL.search(line), f"{path.name}:{number}: {line.strip()}")

    def test_marker_detection_lines_never_say_ai_or_learned(self):
        for path in SOURCES:
            for number, line in lines_of(path):
                if re.search(r"aruco|marker", line, re.IGNORECASE) and re.search(
                        r"\bAI\b|neural|machine learning|deep learning", line):
                    self.assertIsNotNone(DENIAL.search(line), f"{path.name}:{number}: {line.strip()}")

    def test_the_estop_exception_is_narrow(self):
        self.assertIsNone(HAND_OVER.search(without_estop_wording('return {"type": "ack", "of": "estop", "delivered": x}')))
        for claim in ('"delivered": True', "medicine delivered", "delivery", "dose_delivered", "estop delivered",
                      '"of": "takeoff_land", "delivered"', "not delivered"):
            self.assertIsNotNone(HAND_OVER.search(without_estop_wording(claim)), claim)

    def test_machine_readable_strings_are_clean(self):
        words = list(EVENT_TYPES) + list(ABORT_REASONS) + list(BLOCKERS) + list(STATES)
        words += [MARKER_NOT_VISIBLE, NOT_CONFIRMED, DISABLED_OFF_AXIS, "drift_assist", "suggested_trim_roll",
                  "drift_assist_disabled", "pilot_link_lost", "no_pilot_link"]
        for word in words:
            self.assertIsNone(HAND_OVER.search(word), word)
            self.assertIsNone(STRONG_CLAIM.search(word.replace("_", " ")), word)
            self.assertIsNone(re.search(r"(^|_)ai(_|$)", word), word)
        self.assertIn("arrived_at_station", EVENT_TYPES)
        self.assertIn("pickup_acknowledged", EVENT_TYPES)

    def test_test_names_do_not_make_the_claims_either(self):
        for path in TESTS:
            for name in re.findall(r"def (test_\w+)", path.read_text(encoding="utf-8")):
                claims = HAND_OVER.search(name) or STRONG_CLAIM.search(name.replace("_", " "))
                if claims:
                    self.assertIsNotNone(re.search(r"(^|_)(no|not|never)(_|$)", name), f"{path.name}: {name}")
                if re.search(r"(^|_)ai(_|$)", name):
                    self.assertIsNotNone(re.search(r"(^|_)(no|not|never)(_|$)", name), f"{path.name}: {name}")


if __name__ == "__main__":
    unittest.main()
