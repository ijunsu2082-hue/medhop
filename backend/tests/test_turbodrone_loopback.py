"""Real-drone link exercised on the loopback interface only, against tools/fake_wifi_uav.py.

Needs a turbodrone checkout: set MEDHOP_TURBODRONE_BACKEND to its backend/ directory, otherwise the
tests are skipped. The drone address is hard-wired to 127.0.0.1 here. No packet leaves the machine.
"""
import os
import shutil
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

from medhop.config import Settings
from tests.harness import make_temp_dir

TOOLS_DIR = Path(__file__).resolve().parents[1] / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

import fake_wifi_uav  # noqa: E402
from medhop.drone import turbodrone as turbodrone_module  # noqa: E402

BACKEND = os.environ.get("MEDHOP_TURBODRONE_BACKEND", "").strip()
LOOPBACK = "127.0.0.1"
NEUTRAL = (0x80, 0x80, 0x80, 0x80)
ALL_KINDS = {fake_wifi_uav.KIND_RC, fake_wifi_uav.KIND_REQUEST_A, fake_wifi_uav.KIND_REQUEST_B}


def stick_byte(value: float) -> int:
    """What the library puts on the wire for a stick fraction (centre 128, range 0..255)."""
    scaled = 128.0 + value * (127.0 if value >= 0 else 128.0)
    return max(0, min(255, round(scaled)))


def port_is_free() -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.bind((LOOPBACK, fake_wifi_uav.PORT))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def wait_for(predicate, timeout=5.0, step=0.02):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return bool(predicate())


@unittest.skipUnless(BACKEND and os.path.isdir(BACKEND), "MEDHOP_TURBODRONE_BACKEND is not set")
@unittest.skipUnless(port_is_free(), "UDP port 8800 on loopback is in use")
class LoopbackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from medhop.drone.turbodrone import TurbodroneLink
        from medhop.server import MedHopCore

        cls.dir = make_temp_dir()
        cls.fake = fake_wifi_uav.FakeWifiUav().start()
        # battery_low_raw is set explicitly: its default is -1 (check off) since Revision 3
        settings = Settings(drone="real", turbodrone_backend=BACKEND, drone_ip=LOOPBACK,
                            data_dir=cls.dir, person_check="off", battery_low_raw=35)
        link = TurbodroneLink(BACKEND, LOOPBACK, settings.control_rate)   # loopback, always
        cls.core = MedHopCore(settings, link=link)
        try:
            cls.core.start()
        except Exception:
            cls.fake.stop()
            raise

    @classmethod
    def tearDownClass(cls):
        try:
            cls.core.stop()
        finally:
            cls.fake.stop()
            shutil.rmtree(cls.dir, ignore_errors=True)

    def setUp(self):
        self.core.mixer.estop_reset()
        self.core.mixer.set_trim(0.0, 0.0)
        self.core.mixer.pilot_disconnect()
        self.core.runner.abort()
        self.core.runner.set_drift_assist(False)
        self.fake.slide_marker(0.0, reset=True)
        self.core.claim_pilot()                     # a pilot window is connected (a run may start)
        self.addCleanup(self.core.release_pilot)
        self.assertTrue(wait_for(lambda: self.core.status()["link"]["video_live"], 6.0), "no video from the fake drone")
        time.sleep(0.25)

    def commands_since(self, since, kinds=None):
        return self.fake.commands(since=since, kinds=kinds)

    def settled(self, delay=0.3, window=0.4):
        """Commands received in a window that starts `delay` seconds from now."""
        start = time.monotonic() + delay
        time.sleep(delay + window)
        return self.commands_since(start)

    def test_1_video_and_raw_telemetry_arrive(self):
        self.assertTrue(wait_for(lambda: self.core.status()["telemetry"] is not None, 3.0))
        status = self.core.status()
        self.assertEqual(status["mode"], "real")
        self.assertTrue(status["link"]["video_live"])
        self.assertEqual({k: status["link"][k] for k in ("control_up", "drone_seen", "sticks_blocked")},
                         {"control_up": True, "drone_seen": True, "sticks_blocked": False})
        self.assertIs(status["telemetry"]["battery_check_enabled"], True)
        # nominally 15, lower on a busy machine; counted over the last two seconds, so it needs a moment
        self.assertTrue(wait_for(lambda: self.core.status()["link"]["fps"] > 5.0, 4.0), self.core.status()["link"])
        self.assertLess(self.core.status()["link"]["fps"], 19.0)
        telemetry = status["telemetry"]
        self.assertIs(telemetry["simulated"], False)
        self.assertEqual((telemetry["fly_state_raw"], telemetry["battery_raw"], telemetry["flags_raw"]), (1, 42, 16))
        self.assertIs(telemetry["battery_low"], False)
        self.fake.set_status(fly_state=3, battery=33, flags=0x91)
        self.assertTrue(wait_for(lambda: self.core.status()["telemetry"]["battery_raw"] == 33, 3.0))
        telemetry = self.core.status()["telemetry"]
        self.assertEqual((telemetry["fly_state_raw"], telemetry["flags_raw"]), (3, 0x91))
        self.assertIs(telemetry["battery_low"], True)
        self.assertIn("battery_low", self.core.status()["mission"]["blockers"])
        self.fake.set_status(fly_state=1, battery=42, flags=16)
        self.assertTrue(wait_for(lambda: self.core.status()["telemetry"]["battery_raw"] == 42, 3.0))
        # the fake's test picture carries the station marker: it is detected through the real link
        self.assertTrue(wait_for(lambda: self.core.status()["vision"]["marker"] is not None, 3.0))
        self.assertAlmostEqual(self.core.status()["vision"]["marker"]["width"], 40 / 640, delta=0.006)

    def test_2_neutral_sticks_at_rest_in_every_packet_kind(self):
        commands = self.settled()
        self.assertGreater(len(commands), 10)
        self.assertEqual({c.kind for c in commands}, ALL_KINDS)
        self.assertEqual({c.sticks for c in commands}, {NEUTRAL})
        self.assertEqual({c.command for c in commands}, {0})
        self.assertTrue(all(c.checksum_ok for c in commands))

    def test_3_trim_changes_the_roll_and_pitch_bytes(self):
        self.core.mixer.set_trim(0.05, -0.02)
        commands = self.settled()
        expected = (stick_byte(0.05), stick_byte(-0.02), 0x80, 0x80)       # roll, pitch, throttle, yaw
        self.assertEqual(expected, (134, 125, 128, 128))
        self.assertEqual({c.sticks for c in commands}, {expected})
        self.assertEqual({c.kind for c in commands}, ALL_KINDS)

    def test_4_pilot_axes_command(self):
        stop = threading.Event()

        def hold():
            while not stop.is_set():
                self.core.mixer.pilot_axes(0.2, 0.5, 1.0, -1.0)     # throttle, yaw, pitch, roll
                time.sleep(0.05)

        thread = threading.Thread(target=hold, daemon=True)
        thread.start()
        try:
            commands = self.settled(delay=0.6)
        finally:
            stop.set()
            thread.join()
        # pilot axes x max_stick 0.5
        expected = (stick_byte(-0.5), stick_byte(0.5), stick_byte(0.1), stick_byte(0.25))
        self.assertEqual(expected, (64, 192, 141, 160))
        self.assertEqual({c.sticks for c in commands}, {expected})
        self.assertEqual({c.kind for c in commands}, ALL_KINDS)
        self.core.mixer.pilot_disconnect()
        self.assertEqual({c.sticks for c in self.settled(delay=0.2)}, {NEUTRAL})

    def test_5_takeoff_land_sets_toggle_bit_0x01_once(self):
        start = time.monotonic()
        self.assertEqual(self.core.mixer.pilot_toggle(), (True, ""))
        time.sleep(0.8)
        commands = self.commands_since(start)
        with_bit = [c for c in commands if c.command & 0x01]
        self.assertGreater(len(with_bit), 0, "the toggle bit never reached the drone")
        self.assertTrue({fake_wifi_uav.KIND_RC} <= {c.kind for c in with_bit})
        self.assertEqual({c.command for c in commands} - {0x00, 0x01}, set())
        # one press: the bit is held for about 0.15 s and then released for good
        self.assertLess(with_bit[-1].t - with_bit[0].t, 0.3)
        self.assertEqual({c.command for c in commands if c.t > with_bit[-1].t + 0.1}, {0})
        self.assertEqual({c.sticks for c in commands}, {NEUTRAL})

    def test_6_estop_sets_bit_0x02_while_latched_and_sticks_stay_neutral(self):
        # Revision 3: the stop bit is asserted for as long as the e-stop is latched (it used to be gone
        # after 1.0 s) and stops only after the reset.
        self.core.mixer.set_trim(0.05, 0.05)
        time.sleep(0.2)
        start = time.monotonic()
        self.assertEqual(self.core.handle_control({"type": "estop"}), {"type": "ack", "of": "estop", "delivered": True})
        time.sleep(1.2)
        commands = self.commands_since(start)
        with_bit = [c for c in commands if c.command & 0x02]
        self.assertGreater(len(with_bit), 0, "the stop bit never reached the drone")
        self.assertEqual({c.command for c in commands} - {0x00, 0x02}, set())
        self.assertEqual({c.sticks for c in commands if c.t > start + 0.15}, {NEUTRAL}, "no trim after e-stop")
        self.assertEqual({c.command for c in commands if c.t > start + 0.1}, {0x02}, "held while latched")
        self.assertIs(self.core.status()["pilot"]["estop_delivered"], True)
        self.core.mixer.estop_reset()
        reset_at = time.monotonic()
        time.sleep(0.6)
        self.assertEqual({c.command for c in self.commands_since(reset_at + 0.3)}, {0}, "gone after the reset")
        self.assertIs(self.core.status()["pilot"]["estop_delivered"], False)

    def test_7_video_loss_forces_neutral_while_a_mission_command_is_active(self):
        stop = threading.Event()

        def mission():
            while not stop.is_set():
                self.core.mixer.mission_command(0.12, 0.22)       # kept fresh the whole time
                time.sleep(0.03)

        thread = threading.Thread(target=mission, daemon=True)
        thread.start()
        try:
            active = (0x80, stick_byte(0.22), 0x80, stick_byte(0.12))
            self.assertEqual(active, (128, 156, 128, 143))
            self.assertEqual({c.sticks for c in self.settled()}, {active})
            paused_at = time.monotonic()
            self.fake.pause_video(1.2)
            time.sleep(1.0)
            during = self.commands_since(paused_at)
            first_neutral = next((c.t - paused_at for c in during if c.sticks == NEUTRAL), None)
            self.assertIsNotNone(first_neutral, "sticks never went neutral")
            self.assertLessEqual(first_neutral, 0.7)
            self.assertEqual({c.sticks for c in during if c.t > paused_at + 0.7}, {NEUTRAL})
            type(self).first_neutral_after_video_loss = first_neutral
            # video comes back: the fresh mission command is passed on again
            self.assertTrue(wait_for(lambda: self.core.status()["link"]["video_live"], 3.0))
            self.assertEqual({c.sticks for c in self.settled()}, {active})
        finally:
            stop.set()
            thread.join()

    def test_8_mission_runner_over_the_real_link_goes_neutral_on_video_loss(self):
        self.assertTrue(wait_for(lambda: self.core.status()["mission"]["can_start"], 3.0),
                        self.core.status()["mission"])
        started, blockers = self.core.runner.start(True, None)
        self.assertTrue(started, blockers)
        forward = stick_byte(0.22)
        self.assertTrue(wait_for(lambda: any(c.pitch == forward for c in self.commands_since(time.monotonic() - 0.2)), 3.0))
        self.assertEqual(self.core.runner.state, "approaching")
        paused_at = time.monotonic()
        self.fake.pause_video(1.0)
        time.sleep(0.9)
        during = self.commands_since(paused_at + 0.6)
        self.assertGreater(len(during), 3)
        self.assertEqual({c.sticks for c in during}, {NEUTRAL})
        self.assertEqual({c.command for c in self.commands_since(paused_at)}, {0}, "no toggle, no stop")
        self.assertTrue(self.core.runner.abort("pilot_took_over"))
        self.assertEqual({c.command for c in self.settled()}, {0})


    def test_9_drift_assist_roll_byte_stays_within_the_cap_and_returns_to_trim(self):
        """Drift assist over the real link: decoded roll bytes while a run is active, after an abort
        and after a loss of video. The fake's marker slides left as if the drone drifted right."""
        trim_byte, cap_byte = stick_byte(0.02), stick_byte(0.02 - 0.15)
        self.assertEqual((trim_byte, cap_byte), (131, 111))
        self.core.mixer.set_trim(0.02, 0.0)
        self.core.runner.set_drift_assist(True)
        # This test is about the bytes, not about the self-check: keep the assist from switching
        # itself off when the fake (which never answers roll) leaves it sitting at its bound.
        self.core.runner._assist.cfg.bound_dwell_s = 60.0
        self.addCleanup(setattr, self.core.runner._assist.cfg, "bound_dwell_s", 0.6)
        seen = {}
        for case in ("abort", "video_loss"):
            self.fake.slide_marker(0.0, reset=True)
            self.assertTrue(wait_for(lambda: self.core.status()["mission"]["can_start"], 4.0),
                            self.core.status()["mission"])
            self.assertEqual({c.roll for c in self.settled(delay=0.1, window=0.3)}, {trim_byte})
            started_at = time.monotonic()
            started, blockers = self.core.runner.start(True, None)
            self.assertTrue(started, blockers)
            self.fake.slide_marker(-18.0)
            self.assertTrue(wait_for(lambda: self.core.status()["mission"]["drift_assist"]["roll"] < -0.05, 6.0),
                            self.core.status()["mission"])
            self.assertIs(self.core.status()["mission"]["drift_assist"]["active"], True)
            time.sleep(0.3)
            active = self.commands_since(started_at)
            rolls = [c.roll for c in active]
            self.assertLess(min(rolls), trim_byte - 4, "the roll byte moved")
            self.assertGreaterEqual(min(rolls), cap_byte, "never past trim - 0.15")
            self.assertLessEqual(max(rolls), trim_byte, "never the other way")
            self.assertEqual({c.throttle for c in active}, {0x80}, "never throttle")
            self.assertEqual({c.command for c in active}, {0}, "no toggle, no stop")
            if case == "abort":
                stopped_at = time.monotonic()
                self.assertTrue(self.core.runner.abort("pilot_took_over"))
            else:
                stopped_at = time.monotonic()
                self.fake.pause_video(1.2)
            time.sleep(1.0)
            after = self.commands_since(stopped_at + 0.7)
            self.assertGreater(len(after), 3)
            self.assertEqual({c.sticks for c in after}, {(trim_byte, 0x80, 0x80, 0x80)}, "back to trim only")
            self.assertEqual({c.command for c in self.commands_since(stopped_at)}, {0})
            seen[case] = {"min_roll_byte": min(rolls), "roll_bytes_seen": sorted(set(rolls)),
                          "after": sorted({c.sticks for c in after})}
            self.core.runner.abort("pilot_took_over")
            self.assertTrue(wait_for(lambda: self.core.status()["link"]["video_live"], 4.0))
        type(self).drift_assist_bytes = seen
        print("\ndrift assist over the loopback link, decoded stick bytes (roll, pitch, throttle, yaw):", seen)

    def test_z_estop_pressed_while_the_library_has_closed_its_socket_goes_out_after_reconnect(self):
        """5 s without video: the library closes the shared socket after 4 s and reopens it about
        5 s later. A toggle in the gap is refused; an e-stop in the gap is latched, reported as not
        sent, and the stop bit reaches the drone after the reconnect."""
        link = self.core.link
        self.assertTrue(link.control_up())
        paused_at = time.monotonic()
        self.fake.pause_video(5.0)
        self.assertTrue(wait_for(lambda: not link.control_up(), 7.0, 0.01), "the library never closed its socket")
        down_at = time.monotonic()
        status = self.core.status()["link"]
        self.assertEqual((status["control_up"], status["sticks_blocked"]), (False, True))
        reply = self.core.handle_control({"type": "takeoff_land"})
        self.assertEqual((reply["type"], reply["of"], reply["code"]), ("error", "takeoff_land", "drone_link_down"))
        time.sleep(0.3)
        pressed_at = time.monotonic()
        self.assertEqual(self.core.handle_control({"type": "estop"}), {"type": "ack", "of": "estop", "delivered": False})
        time.sleep(0.5)
        pilot = self.core.status()["pilot"]
        self.assertEqual((pilot["estop_active"], pilot["estop_delivered"]), (True, False))
        self.assertFalse(link.control_up(), "still in the gap")
        self.assertEqual(self.fake.bit_times(0x02, since=pressed_at), [], "nothing can arrive in the gap")
        self.assertTrue(wait_for(link.control_up, 10.0, 0.01), "the library never reconnected")
        up_at = time.monotonic()
        self.assertTrue(wait_for(lambda: self.fake.bit_times(0x02, since=pressed_at), 2.0, 0.01),
                        "the stop bit never reached the drone after the reconnect")
        first_bit_at = self.fake.bit_times(0x02, since=pressed_at)[0]
        self.assertLess(first_bit_at - up_at, 0.5)
        self.assertTrue(wait_for(lambda: self.core.status()["pilot"]["estop_delivered"], 2.0))
        confirmed_at = time.monotonic()
        ports = self.fake.source_ports(since=paused_at - 0.5)
        self.assertGreaterEqual(len(ports), 2, f"expected a new source port after the reconnect: {ports}")
        self.assertEqual(self.fake.bit_times(0x01, since=down_at), [], "the refused toggle was never sent")
        t0 = pressed_at
        type(self).blackout_evidence = {
            "video_paused_at": round(paused_at - t0, 3),
            "control_down_at": round(down_at - t0, 3),
            "estop_pressed_at": 0.0,
            "control_up_again_at": round(up_at - t0, 3),
            "first_stop_bit_at_fake": round(first_bit_at - t0, 3),
            "estop_delivered_true_by": round(confirmed_at - t0, 3),
            "source_ports": [(round(t - t0, 3), port) for t, port in ports],
        }
        print("\ne-stop during the library's reconnect gap (seconds from the press):", self.blackout_evidence)
        self.core.mixer.estop_reset()
        self.assertTrue(wait_for(lambda: self.core.status()["link"]["video_live"], 6.0))


@unittest.skipUnless(BACKEND and os.path.isdir(BACKEND), "MEDHOP_TURBODRONE_BACKEND is not set")
@unittest.skipUnless(port_is_free(), "UDP port 8800 on loopback is in use")
class ShutdownTests(unittest.TestCase):
    def test_stop_sends_neutral_never_the_toggle_and_releases_everything(self):
        from medhop.drone.turbodrone import TurbodroneLink

        with fake_wifi_uav.FakeWifiUav() as fake:
            link = TurbodroneLink(BACKEND, LOOPBACK, 20.0)
            link.start()
            try:
                self.assertTrue(wait_for(lambda: link.latest_frame() is not None, 5.0))
                link.set_axes(0.0, 0.3, 0.3, 0.0)
                time.sleep(0.3)
                self.assertNotEqual(fake.commands()[-1].sticks, NEUTRAL)
                stopping_at = time.monotonic()
            finally:
                link.stop()
            stopped_at = time.monotonic()
            self.assertLess(stopped_at - stopping_at, 4.0)
            tail = fake.commands(since=stopping_at)
            self.assertGreater(len(tail), 0)
            self.assertEqual(tail[-1].sticks, NEUTRAL, "the last thing the drone hears is neutral")
            self.assertEqual({c.command for c in tail}, {0})
            time.sleep(0.4)
            self.assertEqual(fake.packets(since=stopped_at + 0.1), [], "nothing is sent after stop")
        names = {t.name for t in threading.enumerate()}
        self.assertFalse({"medhop-frames", "WifiUavVideoRx", "FrameWatchdog"} & names, names)

    def test_no_reply_from_the_drone_logs_one_warning_and_drone_seen_stays_false(self):
        """Nothing listens on 127.0.0.1:8800 here (loopback only). The start is not blocked."""
        from medhop.drone.turbodrone import TurbodroneLink

        self.assertTrue(port_is_free())
        original = turbodrone_module.DRONE_SEEN_TIMEOUT_S
        turbodrone_module.DRONE_SEEN_TIMEOUT_S = 0.5
        self.addCleanup(setattr, turbodrone_module, "DRONE_SEEN_TIMEOUT_S", original)
        link = TurbodroneLink(BACKEND, LOOPBACK, 20.0)
        with self.assertLogs("medhop.drone.turbodrone", level="WARNING") as logs:
            started = time.monotonic()
            link.start()
            try:
                self.assertLess(time.monotonic() - started, 0.5, "start does not wait for the drone")
                time.sleep(1.0)
                self.assertIs(link.drone_seen(), False)
                self.assertIsNone(link.latest_frame())
            finally:
                link.stop()
        warnings = [r for r in logs.output if "no video frame or status message" in r]
        self.assertEqual(len(warnings), 1, logs.output)
        self.assertIn("127.0.0.1", warnings[0])
        self.assertIn("Wi-Fi", warnings[0])

    def test_drone_seen_turns_true_with_the_fake_and_no_warning(self):
        from medhop.drone.turbodrone import TurbodroneLink

        original = turbodrone_module.DRONE_SEEN_TIMEOUT_S
        turbodrone_module.DRONE_SEEN_TIMEOUT_S = 1.5
        self.addCleanup(setattr, turbodrone_module, "DRONE_SEEN_TIMEOUT_S", original)
        with fake_wifi_uav.FakeWifiUav():
            link = TurbodroneLink(BACKEND, LOOPBACK, 20.0)
            self.assertIs(link.drone_seen(), False)
            with self.assertNoLogs("medhop.drone.turbodrone", level="WARNING"):
                link.start()
                try:
                    self.assertTrue(wait_for(link.drone_seen, 3.0))
                    time.sleep(1.0)       # past the (shortened) timeout
                finally:
                    link.stop()

    def test_missing_backend_path_is_a_clear_error(self):
        from medhop.drone.turbodrone import TurbodroneLink

        with self.assertRaises(RuntimeError):
            TurbodroneLink(None, LOOPBACK)
        with self.assertRaises(RuntimeError):
            TurbodroneLink("/nonexistent/turbodrone/backend", LOOPBACK)


if __name__ == "__main__":
    unittest.main()
