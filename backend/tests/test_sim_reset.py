"""The interactive simulator puts the drone back at the start pose on each takeoff from the ground."""

import unittest

from medhop.drone.sim import SimConfig, SimLink


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def fly(sim: SimLink, clock: FakeClock, seconds: float) -> None:
    end = clock.t + seconds
    while clock.t < end:
        clock.t += 0.02
        sim.advance_to(clock.t)


class SimResetTests(unittest.TestCase):
    def make(self, reset: bool):
        clock = FakeClock()
        cfg = SimConfig(seed=0, lateral_drift=0.0, noise_velocity=0.0, noise_yaw_deg=0.0,
                        reset_pose_on_takeoff=reset)
        sim = SimLink(cfg, clock=clock, realtime=False)
        sim.advance_to(clock.t)
        sim.set_pose(distance_m=0.8, x_m=2.0, heading_deg=40.0, airborne=False)
        return sim, clock

    def test_takeoff_from_ground_resets_pose_when_enabled(self) -> None:
        sim, clock = self.make(reset=True)
        sim.takeoff_land_toggle()
        fly(sim, clock, 2.0)
        p = sim.pose()
        self.assertAlmostEqual(p["distance_m"], 2.5, places=2)
        self.assertAlmostEqual(p["x_m"], 0.0, places=2)
        self.assertAlmostEqual(p["heading_deg"], 0.0, places=2)
        self.assertTrue(p["airborne"])

    def test_pose_kept_when_disabled(self) -> None:
        sim, clock = self.make(reset=False)
        sim.takeoff_land_toggle()
        fly(sim, clock, 2.0)
        p = sim.pose()
        self.assertAlmostEqual(p["distance_m"], 0.8, places=2)
        self.assertAlmostEqual(p["x_m"], 2.0, places=2)

    def test_toggle_while_landing_does_not_reset(self) -> None:
        sim, clock = self.make(reset=True)
        sim.set_pose(airborne=True)
        sim.takeoff_land_toggle()       # start landing
        fly(sim, clock, 0.3)
        sim.takeoff_land_toggle()       # climb again from mid-landing
        fly(sim, clock, 2.0)
        p = sim.pose()
        self.assertAlmostEqual(p["distance_m"], 0.8, places=1)
        self.assertAlmostEqual(p["x_m"], 2.0, places=1)


if __name__ == "__main__":
    unittest.main()
