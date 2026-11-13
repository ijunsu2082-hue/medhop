# MedHop safety

Read this before any real flight. Then follow [FLIGHT_CHECKLIST.md](FLIGHT_CHECKLIST.md) step by step.

**Status as of writing:** the drone has flown station runs for real, and there is no footage. In one run
it hovered and did not land. In another it found the sign from about 4 m away and then stalled on the
approach, because the sign was missing from about 45% of the camera frames. Both faults were fixed in
the flight logic and the fixes were tested in the simulator. The project's notes do not record a real
run that went cleanly from takeoff to landing. Everything below about what the software does comes from
reading the code and from tests in the simulator and against a loopback stand-in for the drone
(`backend/tools/fake_wifi_uav.py`). How the real drone reacts to most of it is not known until it has
been tried, carefully, following the checklist.

Only the Python build of the site (`npm run dev`, started by `scripts/fly-real.sh`) can fly the real
drone. The browser build and the hosted site run a simulator inside the page and never reach a drone.
The page says which one it is next to the site name: "Real drone", "Python simulator" or "Browser
simulator".

The drone is a toy camera drone sold as "AXNEN i1". The manufacturer publishes no payload, weight,
battery or flight-time figures that the author could find. It has no GPS. MedHop never uses it to
carry real medicine.

## 1. Rules for any flight

Every one of these, every time. If one cannot be met, do not fly.

1. **Empty corridor.** Fly only in a straight indoor corridor or hallway with nothing in the flight path.
   Never outdoors (no GPS, and wind will carry a toy drone away).
2. **Physical barrier.** Close off both ends of the flight area with doors or a physical barrier, and put
   up a sign so nobody walks in.
3. **Nobody inside.** No people and no pets inside the barrier while the drone is powered. The pilot and
   any helpers stand behind the barrier. Never fly near anyone (never near an older adult or any
   bystander), and never toward a face. The one exception is handling the drone by hand with its motors
   off and emergency stop latched, for the range check and the arrival calibration
   ([FLIGHT_CHECKLIST.md](FLIGHT_CHECKLIST.md) sections C and G). While emergency stop is latched MedHop
   refuses the takeoff/land toggle.
4. **Eye protection** for everyone present.
5. **An adult present** for the whole session.
6. **Prop guards** fitted, if the drone has them. Do not fly with a damaged propeller or guard.
7. **Charged battery**, and a charged laptop. Number your drone batteries so the run log can tell them apart.
8. **Bright room with a textured floor.** The Pilot page warns "Too dark for position hold" when the
   camera picture is dark. The firmware name contains "FLOW", which suggests the drone uses a downward
   camera to hold position; this is not documented by the manufacturer and has not been verified. Avoid
   shiny, plain or very dark floors, and avoid direct sunlight on the floor.
9. **No real medicine**, ever. Use an empty pouch or nothing at all.
10. **The pilot stays at the Pilot page for the whole flight**, hands at the keys, with the page open, in
    front, and with keyboard focus (the Space key only works while that page has focus). Emergency stop
    is not always available: it needs the laptop, the Pilot tab, the backend and the drone link to be up
    (section 2).
11. **Look at the drone before pressing "Takeoff / Land (toggle)".** It is one shared toggle (section 3).
12. **Only one controller.** Quit turbodrone's own server and frontend and close the WiFi UAV phone app
    before starting MedHop. `scripts/fly-real.sh` refuses to start while turbodrone's server is running;
    it cannot see the phone app.
13. **Open the Care and Caregiver pages in a separate window**, never by navigating away from the Pilot
    page. Leaving the Pilot page closes its control link (section 2, "Pilot connection lost").

### LiPo battery care

Toy drones like this normally use lithium-polymer (LiPo) batteries. Treat them with care:

- Charge only with the charger that came with the drone, on a non-flammable surface, and never leave a
  charging battery unattended.
- Let a battery cool down after flying before charging it.
- Never charge or fly a battery that is swollen ("puffy"), dented, punctured or hot. Stop using it and
  dispose of it through a battery recycling point.
- Unplug the battery from the drone after the session. Store batteries somewhere cool and dry.

## 2. What the software failsafes do, and what they do NOT do

"Neutral" below means the sticks are centred (throttle, yaw, pitch and roll all zero) with the roll and
pitch trim from the Trim panel still added. The software can only choose what stick values to send. What
the drone physically does with neutral sticks (hover in place, drift, sink) has not been measured on
this drone.

| Failsafe | What it does (from the code) | What it does NOT do |
|---|---|---|
| **Video-stale neutral** | The control mixer (`backend/medhop/mixer.py`) ignores station-run commands whenever the newest video frame is older than 0.5 s, and sends neutral instead. The mission runner itself holds neutral after 0.25 s without a new frame, and aborts the run with reason `video_stale` once the frame is older than 1.5 s. In real mode, once the newest frame is older than 3.0 s, the mixer also replaces the pilot's sticks with neutral (status `link.sticks_blocked`), so the last stick packets before the library's 4 s reconnect are neutral. Emergency stop and the toggle stay available. | Between 0.5 s and 3.0 s of stale video the pilot can still fly by eye; after 3.0 s the pilot cannot steer until video returns. It does not land the drone. If the Wi-Fi link drops suddenly, the last packet that reached the drone may be whatever was being sent at that moment, held sticks included (see section 3). |
| **An abort never sends the toggle** | On every abort (any reason) the run stops steering, the mixer goes back to neutral, and the takeoff/land toggle is NOT sent. The Pilot page shows "Take manual control and land". | It does not land the drone. The drone stays wherever it is, at whatever neutral sticks make it do. **The pilot lands by hand.** |
| **Pilot input aborts the run** | Any non-zero stick input from the pilot, the takeoff/land toggle, or emergency stop aborts a running station run at once (reason `pilot_took_over`, or `estop` for emergency stop). Pilot sticks always win over station-run commands. Pilot sticks count as active for 0.4 s after the last non-zero message; the Pilot page resends held keys every 50 ms. | Pressing nothing does not abort: if the pilot just watches, the run carries on. |
| **Pilot connection lost** | If the Pilot page's control connection drops (tab closed, browser crash, or navigating the Pilot tab to another page), the backend zeroes the pilot's sticks immediately and aborts a running station run or hover test with reason `pilot_link_lost` (neutral sticks, no toggle). A run or hover test cannot start without a connected Pilot page (blocker `no_pilot_link`). Switching tabs or windows releases all held keys, and so does the control link leaving its open state. | It does not land the drone. With the Pilot page closed nobody can steer, land or emergency-stop the drone through MedHop; the backend only keeps sending neutral sticks until a Pilot page connects again. |
| **Start blockers** | A station run refuses to start without the "The drone is hovering and the corridor is empty" tick (`confirm_airborne_required`), and when no Pilot page is connected (`no_pilot_link`), there is no live video (`no_video`), emergency stop is active (`estop_active`), a run or hover test is already going (`already_running`), the advisory person check sees a person (`person_in_view`), something stands in the lane (`obstacle_in_view`; only the simulator reports objects, so on the real drone this never fires), the battery check is on and a reading younger than 3 s is at or below `MEDHOP_BATTERY_LOW_RAW` (`battery_low`), or the sign already looks arrival-sized (`marker_too_close`). The hover test and arrival calibration also refuse when no sign is visible (`marker_not_visible`). | It cannot check that the drone is really hovering, that the corridor is really empty, or that the battery is really low. The battery byte's meaning is not verified, so the battery check is **off by default** (`MEDHOP_BATTERY_LOW_RAW=-1`); see the checklist's battery notes. |
| **Sign detection limits** | The detector ignores anything narrower than 0.025 of the frame width (16 px), and the run only moves from searching to approaching after 3 detections in a row whose centres agree within 0.1 of the frame width. This cuts false detections. In the simulator this cut-off ends detection at about 4.7 m (simulator figure only). | Detection is only reliable from about 25 px (about 0.04 of the frame width); a reviewer measured this by pasting the sign into frames recorded from this drone's camera, not in flight. Measure the real range with the checklist's motors-off range check (section C). |
| **Arrival evidence** | "Arrived at station" needs the sign at or above the arrival size on 3 detections in a row AND the sign must have grown by at least 15 % since the run first saw it (evidence the drone moved toward it). The size is corrected for viewing angle. | It does not measure distance in metres. It is only as good as the arrival calibration (checklist section G). The drone keeps moving for a moment after arrival is detected, because the video is about 0.45 s old: start with a stopping distance of at least 1.0 m. |
| **Off-axis abort** | If the sign looks too narrow for its height (width/height under 0.70, about 45 degrees off to the side) on 3 detections in a row, the run aborts with `off_axis`. | It does not steer the drone back in front of the sign. |
| **Search and lost limits** | If the sign is not found within 12 s of slow turning, abort `marker_not_found`. If it is lost during the approach: the first 0.5 s counts as a detection dropout (it coasts on its last forward stick, fading to zero, with no yaw, and never forward when it was already close to the sign), then neutral up to 0.6 s in all, then it turns slowly toward where it was last seen for up to 2 s, then abort `marker_lost`. Whole run: abort `timeout` after 45 s. | It does not guarantee the turning is safe: the drone turns where it is. |
| **Settle guards** | After arrival the run holds neutral for 1.2 s (the settle). If the sign was not seen in the last 0.3 s of that settle, it aborts with `marker_lost` and does not send the toggle (the drone may already be coming down by itself). Descent guard, only when the landing command on arrival is switched on: after the first 0.25 s of neutral, the median height of the sign in the first 3 settle detections is the reference. If 3 detections in a row then show the sign more than 0.08 of the frame height ABOVE that reference (scaled up for a landing distance closer than 0.8 m: about 0.14 at the default 0.45 m) (the camera is going down, so the drone may be landing by itself), the run aborts with `unexpected_descent` and does not send the toggle. The landing toggle waits until the guard has cleared; if it has not cleared within 1.0 s after the settle, the toggle is skipped and the run ends `done` (event detail `landing_skipped: "settle_guard_undecided"`), and the pilot lands by hand. With the landing command off (the default) the descent guard neither holds nor aborts the run. If the backend refuses the toggle (see Toggle guards), the run also ends `done` without it (event detail `landing_skipped: "refused_by_mixer"`). Status `mission.last_landing` says which happened (`sent`, `skipped_settle_guard_undecided`, `refused_by_mixer` or `off`), and the Pilot page's end-of-run message follows it (the five messages are quoted in FLIGHT_CHECKLIST.md step 59 and SPEC.md 10.4). | It cannot tell why the sign vanished or moved. It does not catch a drone that sinks so slowly that the sign moves less than that, and it ignores the sign moving down the picture. Known limit (simulator finding): it has a blind window. With about 0.35 s of video lag, a descent that starts about 0.8 s or later into the 1.2 s settle is not yet seen, and the run can still send the landing toggle to a drone that is already coming down. This is one reason the landing command on arrival is off by default. |
| **Drift assist (experimental, off by default)** | When switched on, during the approach only, it adds a small roll command (never more than 0.15 of full stick) to counter sideways drift, estimated from the camera picture only. It waits until the first turn toward the sign is over, and it switches itself off for the rest of the run if its own off-axis checks say it is making things worse (for example if roll pushes this drone the opposite way). | It has never been tried on the real drone. It never touches throttle and sends no roll outside the approach. It cannot see drift that the camera does not show. Use it only after Test 2 in the checklist passed (no reversed directions). |
| **Toggle guards** | The takeoff/land toggle is refused while emergency stop is latched (`estop_active`), and a second toggle within 1.0 s of the last one is ignored (`toggle_guard`). For 4 s after a station run sends its own landing toggle, the pilot's toggle is refused (`landing_in_progress`); while the run is in its landing state the page disables the button and shows "Landing in progress". A pilot toggle is refused while the drone link is down (`drone_link_down`), so it is not silently lost. On the Pilot page the button must be held for 0.6 s (or the T key held). A station run sends the toggle at most once, only after a confirmed arrival, only when "Send the landing command on arrival (off: you land by hand)" is ticked, and not if any pilot input arrived since the run's last command or in the last 0.4 s (the pilot-quiet rule; the run then ends `done` with `landing_skipped: "refused_by_mixer"` and the pilot lands by hand). That setting is **off by default** and is remembered across restarts. | It cannot know whether the drone is on the ground or in the air. A toggle on the ground takes off; in the air it lands. |
| **Emergency stop** | "EMERGENCY STOP" (or Space) latches the stop. While it is latched, the backend sends the motor-cut command on every control tick (20 times a second), sticks are neutral with no trim, and the toggle is refused, until "Reset emergency stop" is pressed. The page says "Emergency stop SENT, not confirmed" until the backend reports the latch (or "Emergency stop NOT confirmed: the backend did not answer within half a second." if it does not), then "Emergency stop active" with "Motor-cut command is being sent to the drone." once the stop has gone out on an open link for 0.5 s (status `pilot.estop_delivered`). If the drone link is reconnecting, it says "Emergency stop NOT delivered yet: drone link reconnecting." ("delivered" here means the stop command, nothing else); the backend keeps trying and the stop goes out as soon as the link returns. With the control link down it says "Emergency stop NOT sent: the control link is down.", and with the backend unreachable "Emergency stop state unknown: the backend is not reachable." | **The drone falls.** It does not land gently. The drone gives no confirmation, so the page only reports the command as sent and never claims the motor cut is confirmed: confirm by eye. It needs the laptop, the Pilot tab, the backend and the drone link all up. During the library's 5 to 9 s reconnect gap nothing reaches the drone, the stop included. The Space key only works while the Pilot page has keyboard focus, and not while typing in a text box. |
| **Drone link state** | The Pilot page shows the drone link separately from the browser's control link: "Drone link: connected", "Drone link: reconnecting. Commands are not reaching the drone.", or "No reply from the drone yet. Is this laptop on the drone's Wi-Fi?" In real mode, if no video frame or status message arrives within 10 s of starting, the backend logs a warning naming the drone address and the Wi-Fi. | It only knows whether MedHop's socket is open and whether the drone has ever answered. It cannot tell whether a given command reached the drone. |
| **Battery check and telemetry age** | Off by default (`MEDHOP_BATTERY_LOW_RAW=-1`). When switched on, a raw byte at or below the set value blocks a start and aborts a run (`battery_low`). Telemetry older than 3.0 s is treated as absent for every decision; the page shows the byte with its age, or "No recent reading. Last: ..." with the last byte; while the check is off, a battery row with a reading has the verdict "Info", never a pass or fail. | The byte's meaning is not verified. Do not rely on it to warn you before the drone lands by itself. |
| **Backend shutdown** | Stopping the backend (Ctrl-C) sends neutral sticks first and never the toggle. | It does not land the drone. What the drone does when packets stop arriving is not known. |

This table describes the behaviour in SPEC.md, including its Revision 3 (section 10), which was being
added to the code while these docs were updated. Before relying on a row, check that it has a matching
test in `backend/tests/` (`test_mixer.py`, `test_runner.py`, `test_sim_closed_loop.py`, `test_api.py`,
`test_turbodrone_loopback.py`). The loopback tests run against the loopback stand-in and are skipped
unless `MEDHOP_TURBODRONE_BACKEND` is set. Tests show the code does what it says in the simulator and on
the loopback; they do not show that the real drone will respond the same way.

## 3. Hazards the software cannot remove

- **One shared takeoff/land toggle.** The drone has a single command that takes off when it is on the
  ground and lands when it is in the air. If the drone has landed by itself (for example on low battery)
  and anyone presses "Takeoff / Land (toggle)" to "make sure it lands", **it takes off again.** This is
  why aborts never send the toggle. Always look at the drone before pressing it.
- **Unknown behaviour if the laptop, the browser or the Wi-Fi dies.** MedHop runs entirely on the laptop.
  If the laptop sleeps, crashes or drops off the drone's Wi-Fi, MedHop can send nothing, including
  emergency stop. If the Pilot tab closes, the backend sends only neutral sticks and no one can steer,
  land or stop the drone through MedHop. What this drone does when commands stop arriving has not been
  tested. The drone's own handheld remote may be a backup:
  `[author: confirm the handheld remote works as a backup while the laptop is connected]`. Keep the
  laptop plugged in, with sleep disabled, and keep the drone low and short of anything it could hit.
- **A 5 to 9 s control gap after video loss.** When the turbodrone library has received no video for 4 s,
  it closes its connection and reconnects, and control is lost for roughly 5 to 9 s. During that gap
  nothing reaches the drone, including emergency stop. In real mode MedHop replaces the pilot's sticks
  with neutral once video is 3 s old, so when the gap comes from a video stall the last stick packets
  before it are neutral. If emergency stop is latched, the stop is sent again as soon as the link
  returns. That is all it can do.
- **A second controller.** If turbodrone's own server or the WiFi UAV phone app is also connected, the
  drone gets commands from two programs, and MedHop's emergency stop only silences MedHop.
- **Drift.** There is no GPS and no position sensor that MedHop can read. A station run steers by
  turning (yaw) and flying forward (pitch) toward the sign as the camera sees it; sideways drift is only
  countered by the experimental drift assist, if it is switched on, and that has not been tried on the
  real drone. The simulator assumes a steady 0.08 m/s sideways drift; the real drift is unknown until the
  hover test has been run. The hover test reports the peak sideways excursion over 10 s hands-off (an
  estimate in metres; limit 0.5 m by default, `MEDHOP_HOVER_MAX_EXCURSION_M`); the checklist scales it to
  the length of a run and compares it with the measured corridor width. The video also lags the drone by
  roughly 0.4 to 0.5 s.
- **Single drone, no redundancy.** One toy drone, one Wi-Fi link, one laptop. Any one of them failing ends
  the flight in a way MedHop cannot control.
- **Unverified battery and status readings.** The battery and status values are raw bytes whose meaning has
  not been verified. Do not trust them to warn you before the drone lands by itself.
- **A falling drone.** Emergency stop drops the drone from whatever height it is at. Keep heights low and
  fly over a clear floor.

## 4. The advisory person check

MedHop can run a pretrained person detector (YOLO11n, by Ultralytics) on the drone's camera picture. It is
**advisory only. It is not a safety system**, and the rules in section 1 apply whether it is on or off.

What it can do:

- When it is enabled (the `ultralytics` package is installed and `MEDHOP_YOLO_WEIGHTS` points at a local
  weights file), it checks about 5 frames a second for people (confidence 0.4 or higher) and draws boxes
  on the video.
- A person seen in the last 2 s blocks a station run from starting (`person_in_view`) and aborts a run that
  is in progress (reason `person_in_view`). Like every abort, that only stops the run steering; it does not
  land the drone. That is the behaviour with waiting for people `off`, the default on the real drone.
  With it set to `hold`, a person seen while the drone is in the air makes the run wait instead
  (section 5).
- The Pilot page's pre-flight checklist shows it as "Advisory person check".

What it cannot do:

- It only sees what the forward camera sees. Anyone beside, behind, above or below the drone is invisible
  to it.
- It can miss people: partly hidden, very close, in poor light, blurred by motion, or simply missed by the
  model. Its accuracy on this drone's camera has not been measured.
- It looks only for people. It does not detect pets or objects.
- It runs a little behind the video, which is itself about 0.4 to 0.5 s behind the drone.
- If the weights file or the `ultralytics` package is missing, it is simply off. The checklist then shows
  "Off. Check the corridor by eye." Nothing is downloaded while flying (the laptop has no internet on the
  drone's Wi-Fi), so download the weights beforehand if you want it.

A "Clear" result never means the corridor is empty. Check the corridor with your own eyes every time.

## 5. Waiting for people and obstacles (experimental)

"Wait for people and obstacles" on the Pilot page (setting `avoid`, `MEDHOP_AVOID`; SPEC section 11).
**It is not a safety system.** It is tested in the simulator only, and the rules in section 1 apply
whether it is on or off. The real drone has never been flown near people and must not be.

What it does (from the code, tested in the simulator):

- It only waits. With something in the drone's lane (0.55 m either side of its line of flight) closer
  than 3.0 m it slows down; closer than 1.8 m it holds still; closer than 0.9 m it backs off a little.
  It carries on once the lane has been clear for 1 s.
- After 25 s blocked in all, it ends the run as `path_blocked`. An automatic run then lands where it is,
  when the camera gives current evidence that the drone is flying. A manual run, or one without that
  evidence, sends no landing command, and the pilot lands by hand.
- A run is refused before takeoff when something stands in the lane (`obstacle_in_view`), or when a
  person is in view (`person_in_view`).
- The setting is `hold` or `off`. It is `hold` by default in the simulator and **`off` by default on the
  real drone**. With it off, a person in view still stops the run (`person_in_view`).

What it does NOT do:

- It never goes around anything. Going around was built, reached the station in 1 of 20 simulated runs,
  and was removed (SPEC 11.8).
- On the real drone it can only know about people, and only while the optional person check (section 4)
  is running, with all that check's misses and blind spots. Walls, furniture, pets and other objects are
  never detected on the real drone.
- In the simulator every simulated person and object is reported exactly: a perfect detector, which no
  real detector is. The simulator results say nothing about how it would do on the real drone.
- The camera cannot measure anything nearer than about 2.5 m (the floor leaves the bottom of the
  picture), so anything that close counts as in the lane, wherever it is.
