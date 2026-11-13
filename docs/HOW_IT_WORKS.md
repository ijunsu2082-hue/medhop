# How MedHop works

A plain-English walk through the code, so the author can explain it to judges. Each section says what a
module does, the one idea to understand, and a question a judge might ask with a truthful answer. File
paths are relative to the repo root. Numbers are the defaults in the code.

## The big picture

```
 browser (frontend/, port 5180)                    laptop backend (backend/medhop/, port 8010)
 ------------------------------                    -------------------------------------------
 Pilot page   --keys, buttons-->  /ws/control  -->  server.py --> mixer.py --set_axes--> drone link
 Care page    --"I picked it up"-> REST         -->  care/store.py (data/*.json, events.jsonl)
 Caregiver    --schedule edits-->  REST                                   |
 all pages    <--status 5x/s----  /ws/status                              v
 Pilot page   <--annotated video- /video.mjpg  <--  vision/worker.py <-- frames from the link
                                                        |  marker.py (ArUco), person.py (YOLO, optional)
                                                        v
                                                    mission/runner.py --yaw, pitch--> mixer.py
```

The drone link is either the simulator (`drone/sim.py`, the default) or the real drone through the
third-party turbodrone library (`drone/turbodrone.py`). Everything else is the same in both modes.

That picture is the **Python build** of the site (`npm run dev`), the only one that can fly the real
drone. The **browser build** (`npm run dev:browser`, and the hosted site) has no laptop backend: the
simulator and a TypeScript port of the backend's code run inside the page (`frontend/src/engine/`,
described under "Frontend" below). Which one a site talks to is fixed when it is built.

Five threads do the work: the control thread (mixer, 20 times a second), the vision thread (every new
frame, which also steps the station run), an optional person-check thread (about 5 times a second), a
once-a-second "care" thread that writes reminder events, and whatever the drone link runs.

---

## Backend

### `backend/medhop/config.py`: settings

**What it does.** Reads the `MEDHOP_*` environment variables into one `Settings` object and refuses to
start on a bad value (for example `MEDHOP_DRONE=plane`).

**The one idea.** Every tunable number that the pilot might need to change lives here, with a safe
default: simulator mode unless `MEDHOP_DRONE=real` is set on purpose.

**Judge:** "Could it fly the real drone by accident?"
**Answer:** Not by default. Real mode needs `MEDHOP_DRONE=real` and a path to a turbodrone checkout, and
the `scripts/fly-real.sh` script also makes you type `yes` after a safety reminder.

### `backend/medhop/drone/base.py`: the drone interface

**What it does.** Defines `DroneLink`, the small set of things any drone must offer: set stick axes,
takeoff/land toggle, emergency stop, gyro calibrate, latest video frame, raw telemetry, and two link
checks: `control_up()` (can a command go out right now?) and `drone_seen()` (has the drone ever
answered?). The toggle and emergency stop return True only when the command went onto an open socket.

**The one idea.** Stick values are fractions from -1 to 1 with fixed signs (+throttle up, +yaw right,
+pitch forward, +roll right). Because the simulator and the real drone share this interface, the same
control code and the same tests run against both.

**Judge:** "Why is there a takeoff/land *toggle* instead of separate buttons?"
**Answer:** The drone's protocol has one shared bit for both. On the ground it takes off, in the air it
lands. That is a hazard, and a lot of the safety rules exist because of it.

### `backend/medhop/drone/sim.py`: the simulator

**What it does.** A 2-D model of the drone in a corridor facing a wall with the station sign. Stick
fractions become speeds (1 m/s forward or sideways and 150 deg/s turning at full stick) with a lag, a
steady 0.08 m/s sideways drift and small random noise. It delays commands and video so the
command-to-video latency is about 0.45 s, similar to the real drone. The camera has two profiles, both
with a 70-degree field of view and the sign drawn in perspective:

- **Drone-like** (the `SimConfig` defaults, `MEDHOP_SIM_CAMERA=drone`): a plain wall and floor at 640x360
  and 15 fps, JPEG quality 50, with noise and blur, close to what the toy drone's camera gives. The
  existing closed-loop, marker and vision tests and every published simulator figure use this profile;
  `tests/test_sim_high_quality.py` covers the display profile, and a test that builds the app from default
  `Settings` (for example in `tests/test_automatic.py`) also runs on it.
- **Display** (`SimConfig.high_quality()`, `drone/sim_scene.py`, the interactive app's default): a
  rendered care-home room at 1280x720 and 15 fps, so the Pilot page has a clear picture to watch. It is
  not the drone's stream, and sign detection in the interactive simulator therefore runs on a cleaner
  picture than the real camera gives. The interactive simulator starts 3.2 m from the sign.

Simulated people and objects (`drone/sim_actors.py`) can stand in or walk across the corridor: upright
boxes drawn as dark silhouettes, which also hide the sign when they are in front of it. They are what
waiting for people reacts to in the simulator (`mission/avoid.py` below).

**The one idea.** The simulator is deliberately unkind (drift, latency, noise, and in the tests a
low-quality picture) so the station-run code is tested against the problems the real drone is expected
to have. It also has test hooks: force an auto-land, freeze the video, hide the sign, set the pose.

**Judge:** "Isn't a simulator result just a made-up result?"
**Answer:** It is not a flight result, and the README keeps the two apart. It shows the control logic
behaves as designed under drift and latency similar to the real drone's. Whether the real drone behaves
like the model is exactly what the real flights have to find out.

### `backend/medhop/drone/turbodrone.py`: the real drone

**What it does.** Connects to the real drone using the open-source turbodrone library (Apache-2.0, by
Marshall Richards), imported from a local checkout (`MEDHOP_TURBODRONE_BACKEND`). It sets the library up
so stick fractions go straight to the drone (no expo curve, full speed tier) and re-checks that on every
control tick. It keeps the newest video frame and reads the raw status bytes the drone sends (fly state,
battery, flags).

**The one idea.** MedHop does not speak the drone's protocol itself; turbodrone does. MedHop only adds a
thin adapter. The status bytes are passed on raw because their meaning is not verified, and telemetry
older than 3.0 s is treated as absent. On stop it sends neutral sticks and never the toggle.
`control_up()` is False while the library's shared socket is closed (during its 5 to 9 s reconnect after
4 s without video), and `drone_seen()` turns True on the first video frame or status message. If neither
arrives within 10 s of starting, it logs a warning naming the drone address and the Wi-Fi.

**Judge:** "Did you reverse-engineer the drone?"
**Answer:** No. Marshall Richards' turbodrone project did that. MedHop uses it, and the real-drone mode
also needs the author's own earlier local changes to turbodrone, made with AI assistance on
2026-11-04/05 and not committed (see [PROVENANCE.md](PROVENANCE.md)).

### `backend/medhop/mixer.py`: the one place that sends sticks

**What it does.** Twenty times a second it decides what the drone gets, in this priority order:
1. emergency stop latched: neutral, no trim, and the motor-cut command again on every tick, until reset;
2. the pilot is active (a non-zero stick message in the last 0.4 s): the pilot's sticks times "Max stick",
   except in real mode once the newest frame is older than 3.0 s, when it sends neutral instead
   (`link.sticks_blocked`), ahead of the library's 4 s reconnect;
3. a fresh station-run command (under 0.5 s old) **and** live video (frame under 0.5 s old): the run's yaw
   and pitch, plus a drift-assist roll that the mixer itself caps at 0.15 (never throttle);
4. otherwise neutral.
Then roll and pitch trim are added (except during emergency stop) and everything is clamped to -1..1; a
value that is not a finite number becomes 0. Pilot sticks ramp at 4.0 per second so a key tap does not
jerk the drone. Any pilot input (sticks, toggle, emergency stop) aborts a station run. Status
`pilot.estop_delivered` turns True once the stop has gone out on an open socket for 0.5 s since it was
latched.

Toggle rules: refused while emergency stop is latched (`estop_active`); a second toggle within 1.0 s is
ignored (`toggle_guard`); a pilot toggle is refused for 4 s after a station run's own landing toggle
(`landing_in_progress`) and while the drone link is down (`drone_link_down`); the run's own toggle is
refused if any pilot input arrived since the run's last command.

**The one idea.** Only the mixer may send sticks. The station run can only *ask*; the pilot always wins;
stale video silences the station run, and in real mode very stale video silences the pilot's sticks too,
so the packets before a reconnect gap are neutral.

**Judge:** "What if the pilot and the computer disagree?"
**Answer:** The pilot wins at once, and the run is aborted, not paused. It does not resume on its own.

### `backend/medhop/vision/marker.py`: finding the station sign

**What it does.** Finds the station sign in each frame using ArUco markers from OpenCV (dictionary
DICT_4X4_50, id 7). It reports the sign's centre, width and height as fractions of the frame. It also
draws the printable A4 sign.

**The one idea.** This is classical computer vision, not AI: a printed black-and-white square pattern
that OpenCV finds by thresholding and shape fitting. Width shrinks when the sign is seen from the side, so
MedHop uses the larger of the width and height ("size"), which does not shrink with viewing angle,
before comparing it with the arrival size.

Limits: detections narrower than 0.025 of the frame width (16 px) are ignored, and the detector's shape
settings are tightened (`minMarkerPerimeterRate` 0.07, `polygonalApproxAccuracyRate` 0.03) to cut false
detections. A reviewer found detection reliable from about 25 px wide by pasting the sign into frames
recorded from this drone's camera; that is not a flight measurement. In the simulator (0.18 m sign,
640 px frame) the 0.025 cut-off means detection ends at about 4.7 m (simulator figure, not a flight
measurement). The checklist's motors-off range check measures the real range.

**Judge:** "Why a printed marker instead of recognising the room?"
**Answer:** It is simple, cheap and checkable: the drone either sees this exact pattern or it does not, and
its size in the picture says roughly how close it is. The detection rate by distance is tested on
simulator frames in `backend/tests/test_marker.py`; it has not been measured on the real camera yet.

### `backend/medhop/vision/person.py`: the advisory person check

**What it does.** Optionally runs a pretrained YOLO11n person detector (Ultralytics) on frames, about 5
times a second, on its own thread. It only loads a local weights file and never downloads anything. If
the package or the file is missing it reports itself as off and everything else still works.

**The one idea.** It is *advisory*: it can block a start and abort a run when it sees a person, but it
can miss people and only sees in front of the camera. The real protection is the empty, closed-off
corridor.

**Judge:** "Is the person check a safety feature?"
**Answer:** No. It is an advisory check. It only sees what the forward camera sees, it can miss people,
and its accuracy on this camera has not been measured. The flights are only ever done in an empty,
closed-off corridor with nobody inside, whatever the check says. When it does see a person, the run
stops steering; it does not land the drone. (That is with waiting for people `off`, the real drone's
default. With it on, the run holds and waits instead; see `mission/avoid.py`.)

### `backend/medhop/vision/worker.py`: the vision thread

**What it does.** Takes the newest frame, decodes it, finds the sign, measures brightness (below 40 out
of 255 is reported as dark), hands the frame to the person check, steps the station run, and draws the
annotated video (sign outline, person boxes, state text) for `/video.mjpg`. When no new frame comes it
still steps the station run about 20 times a second, so its timers and failsafes keep running.

**The one idea.** The station run is driven by frames, but never *waits* for frames: no video is itself
an event the run reacts to.

**Judge:** "What does the video on the Pilot page show?"
**Answer:** The drone's camera picture with what the software sees drawn on it: the sign outline, person
boxes if the check is on, and the mode and run state. It is about 0.4 to 0.5 s behind reality on the real
drone (not yet measured by MedHop itself).

### `backend/medhop/mission/steering.py`: the steering maths

**What it does.** Pure functions, no clocks or I/O. Turn (yaw) so the sign moves to the centre of the
picture; fly forward only when the sign is within 0.15 frame-widths of centre; forward stick is capped at
0.22 and tapers to 0.10 as the sign grows toward the arrival size; commands may grow by at most 1.0 per
second but drop at once. Turning is capped at 0.25.

**The one idea.** The video is about half a second old, so steering on where the sign *appears* would
overshoot. The code subtracts the effect of turn commands already sent but not yet visible in the video
(a "Smith predictor"). The test suite checks it stays stable even if the real turning speed is twice the
assumed one.

The same file holds the drift-assist maths (`DriftAssist`), described under the runner below.

**Judge:** "Why doesn't it just fly straight at the sign?"
**Answer:** The drone cannot know where it is, only what the camera shows half a second late. So it turns
slowly to centre the sign, accounts for the delay, and only creeps forward when the sign is centred.

### `backend/medhop/mission/runner.py`: the station run

**What it does.** The state machine for a station run: `idle` -> `searching` (slow turn, up to 12 s) or
`approaching` -> `arrived` (hold still 1.2 s, the settle) -> `landing` (one toggle, then wait 4 s) -> `done`; or
`aborted` with a reason. Searching moves to approaching only after 3 detections of the sign in a row
whose centres agree within 0.1 of the frame width. It also runs the 10 s hover test and the arrival
calibration, writes the events (`run_started`, `arrived_at_station`, `run_aborted`, `hover_test`) and a
per-run trace file in `data/runs/`.

It refuses to start without the pilot's "The drone is hovering and the corridor is empty" confirmation,
and when any blocker in the table below applies. It never takes off by itself.

**The one idea.** On ANY abort it goes neutral and **never** sends the toggle, because if the drone has
already landed by itself (for example on low battery) the toggle would launch it again. The only toggle
a run ever sends is the landing toggle after a confirmed arrival, and only if "Send the landing command
on arrival (off: you land by hand)" is ticked. That setting is **off by default** and remembered across
restarts, so by default a run ends with the drone hovering at the sign and the pilot lands it by hand.

| Abort reason | When |
|---|---|
| `marker_not_found` | the sign was not found within 12 s of slow turning |
| `marker_lost` | the sign was lost during the approach (after 0.6 s of coasting then neutral, and 2.0 s of creep-search), or not seen in the last 0.3 s of the settle |
| `off_axis` | the sign looked too narrow for its height (under 0.70) on 3 detections in a row |
| `unexpected_descent` | landing command on arrival switched on, and during the settle 3 detections in a row showed the sign more than 0.08 of the frame height (about 0.14 at the default 0.45 m landing distance) above its reference height |
| `video_stale` | the newest frame is older than 1.5 s |
| `timeout` | the run took longer than 45 s |
| `pilot_took_over` | the pilot sent stick input or the toggle |
| `pilot_link_lost` | the Pilot page's control link closed during the run or hover test |
| `person_in_view` | the advisory person check saw a person in the last 2 s (with waiting for people `off`; with it on, the run waits instead) |
| `path_blocked` | waiting for people and obstacles was on and the lane stayed blocked for 25 s in all (see `mission/avoid.py` below) |
| `obstacle_in_view` | during an automatic run's countdown on the ground, something stood in the lane |
| `battery_low` | the battery check is on and a reading younger than 3 s is at or below `MEDHOP_BATTERY_LOW_RAW` |
| `estop` | emergency stop was pressed |

| Start blocker | Meaning |
|---|---|
| `confirm_airborne_required` | the "drone is hovering and the corridor is empty" box is not ticked |
| `no_pilot_link` | no Pilot page is connected (also blocks the hover test) |
| `no_video` | no live video |
| `estop_active` | emergency stop is latched |
| `already_running` | a run or hover test is already going |
| `person_in_view` | the advisory person check sees a person (or, in the simulator, a simulated person is in the picture) |
| `obstacle_in_view` | something stands in the lane (only the simulator reports objects, so on the real drone this never fires) |
| `battery_low` | as for the abort reason (never, while the check is off) |
| `marker_too_close` | the sign already looks arrival-sized |
| `marker_not_visible` | no sign in view (hover test and arrival calibration) |

The control socket answers a refused command with an error `code`: `landing_in_progress`,
`drone_link_down`, `estop_active` or `toggle_guard` (see the mixer above).

The hover test sends neutral (trim still applies) for 10 s while the drone faces the sign and records
the sign's position. It reports the **peak** sideways excursion (the largest minus the smallest
sideways position of the sign during the test, converted to metres with the printed sign size), the
limit (`MEDHOP_HOVER_MAX_EXCURSION_M`, default 0.5 m), the width change and how often the sign was
visible. It passes when the peak excursion is within the limit and the sign was visible at least 80 % of
the time. A turn looks the same as a sideways drift in this measurement, which is why the metres figure
is only an estimate.

Later additions (SPEC "Revision 2" and "Revision 3"), added to the code while these docs were being
written:

- **Settle descent guard.** The reference is the median height of the sign in the first 3 settle
  detections, taken after the first 0.25 s of neutral. If 3 detections in a row then show the sign more
  than 0.08 of the frame height ABOVE that reference (scaled up for a landing distance closer than
  0.8 m: about 0.14 at the default 0.45 m), the camera is going down, so the drone may be
  landing by itself. The run aborts with `unexpected_descent` and does not send the toggle. The guard
  only acts when the landing command on arrival is on: the landing toggle then waits until the guard
  has cleared, and if it has not cleared within 1.0 s after the 1.2 s settle, the toggle is skipped and
  the run ends `done` (event detail `landing_skipped: "settle_guard_undecided"`). With the landing
  command off (the default) the guard neither holds nor aborts the run.
  Known limit (simulator finding): the guard has a blind window. With about 0.35 s of video lag, a
  descent that starts about 0.8 s or later into the 1.2 s settle is not yet seen, and the run can still
  send the landing toggle. This is one reason the landing command on arrival is off by default.
- **Pilot-quiet rule.** The control mixer refuses the run's landing toggle if any pilot input (sticks,
  toggle or emergency stop) arrived in the last 0.4 s, as well as since the run's last command. The run
  then ends `done` without the toggle (event detail `landing_skipped: "refused_by_mixer"`) and the pilot
  lands by hand.
- **Landing result.** Status `mission.last_landing` says how the latest run ended its arrival: `sent`,
  `skipped_settle_guard_undecided`, `refused_by_mixer` or `off` (null before the run arrives; reset at
  each start). The Pilot page's end-of-run message follows it exactly:
  - `sent`: "Arrived at station. The landing command was sent once: check that the drone has landed."
  - `skipped_settle_guard_undecided`: "Arrived at station. The landing command was NOT sent (the descent check could not decide). Land by hand."
  - `refused_by_mixer`: "Arrived at station. The landing command was NOT sent (the safety layer refused it, for example because you used the controls just before or the drone link was down). Land by hand."
  - `off`: "Arrived at station. Landing on arrival is off: land by hand."
  - null or missing (older backend): "Arrived at station. Check whether the drone has landed; land by hand if not."
- **Drift assist** (experimental, off by default, the switch is remembered). During the approach it adds
  a roll command of at most 0.15 to cancel sideways drift. The idea: a drone that slides sideways has to
  keep turning to keep the sign centred, so "yaw command divided by sign width" measures the slide
  without knowing the distance. The roll is the running total of that measure (an integrator), capped at
  0.15. It only starts once the first turn toward the sign is over, so a drone that merely started off
  to one side is not mistaken for one that drifts. If its own checks say the drone is moving further
  off-axis while it pushes (for example because roll works the other way round on this drone), it
  switches itself off for the rest of the run. After an arrival it suggests a roll trim (current trim
  plus its average roll near the end), shown on the Pilot page with "Apply as trim". It has not been
  tried on the real drone.

  What the simulator showed (simulator, Revision 3 build, 2026-11-11: 10 seeds, start 2.5 m from the
  sign, 0.45 s latency; not flight results; not repeated on the current build):
  - With +0.08 m/s of simulated sideways drift, runs ended 0.53 to 0.79 m (mean 0.64 m) off the sign's
    axis with the assist off, and 0.13 to 0.26 m (mean 0.17 m) with it on.
  - With +0.20 m/s of drift, runs ended 0.75 to 0.99 m (mean 0.84 m) off axis even with the assist on:
    the 0.15 cap cannot cancel that much. This is a known limit; the fix is roll trim first, assist
    second.
  - With the roll direction reversed (as it would be if roll works the other way on the real drone),
    the assist made things worse for 3 to 5 s before switching itself off (`off_axis_worsening`), and
    runs ended 0.6 to 1.0 m off axis (Revision 2 simulator run).
  - The suggested roll trim was about 0.03 too large at 0.08 m/s, so the checklist says to apply about
    half and repeat the hover test (Revision 2 simulator run).
  - An estimate from the camera alone cannot tell a slow turn (yaw drift) from a sideways slide when the
    sign is far away.

**Judge:** "How do you know it arrived?"
**Answer:** From the camera only. "Arrived at station" needs the sign to look at least as big as the
calibrated arrival size (corrected for viewing angle) on 3 frames in a row, AND to have grown by at least
15 % since the run first saw it, which is evidence that the drone actually moved toward it. Then it holds
still for 1.2 s and checks the sign is still in view before logging the arrival; with the landing
command on arrival switched on it also waits for the descent guard (the sign must not have moved up the
picture) before it sends the landing toggle. It does not measure metres, and it does not know whether anything was
picked up. The event records the mode (`"sim"` or `"real"`), and the Care and Caregiver pages label
simulator arrivals as simulator.

### `backend/medhop/mission/avoid.py`: waiting for people and obstacles

**What it does.** Pure functions and a small state machine (`Avoider`), stepped once per frame while the
run is searching, approaching or lining up. From each box in the picture it estimates how far away the
thing is and how far to the side, and whether it is in the drone's lane (0.55 m either side of its line
of flight). Then: something in the lane closer than 3.0 m, slow down (forward stick at most 0.10);
closer than 1.8 m, hold still; closer than 0.9 m, back off a little. It carries on once the lane has
been clear for 1 s. After 25 s blocked in all, the runner ends the run with `path_blocked`, and an
automatic run lands where it is. A run is refused before takeoff when something stands in the lane
(`obstacle_in_view`). The Pilot page's switch is "Wait for people and obstacles" (setting `avoid`, `hold`
or `off`; `MEDHOP_AVOID`): `hold` by default in the simulator, `off` by default on the real drone. With
it off, a person the optional person check sees still stops the run (`person_in_view`), as before.

What it sees: in the simulator, the simulated people and objects of `drone/sim_actors.py` (the Pilot
page's "Corridor" list: "Empty corridor", "A person walks across", "A person stands in the way", "A
trolley is in the way", "The corridor is blocked"), reported exactly. On the real drone, only people,
and only while the optional person check is running.

**The one idea.** It only ever waits. It never steers round anything. Going around was built, reached
the station in 1 of 20 simulated runs, and was removed (SPEC 11.8): the camera cannot judge distance to
anything nearer than about 2.5 m, where the floor leaves the bottom of the picture.

What the simulator showed (simulator, this build, 2026-11-13, 20 seeds each; not flight results; the
README has the full table): a person walking across, all 20 waited and then landed at the station,
never closer than 1.17 m; a person standing in the way, all 20 ended `path_blocked` and landed where
they were, never closer than 1.77 m; three people blocking the corridor, the same, never closer than
1.10 m.

**Judge:** "So the drone avoids people?"
**Answer:** It waits for them in the simulator, where it sees every simulated person perfectly. It is
not a safety system. On the real drone it is off by default and can only know about people the
optional person check sees. The real drone has never been flown near people and must not be.

### `backend/medhop/care/store.py`: the data files

**What it does.** Keeps the schedule (`data/schedule.json`), the event log (`data/events.jsonl`, one JSON
object per line), trim, arrival calibration and run traces. On first start it seeds three doses whose
labels end in "(demo)". Dose ids are never reused. A file that cannot be read is renamed, not
overwritten.

**The one idea.** Plain local files, no accounts, no database, no network. The log is append-only, so it
reads like a diary of what happened.

**Judge:** "Where is the patient data stored?"
**Answer:** There is no real patient data: demo data only, in plain files on the laptop, sent nowhere.

### `backend/medhop/care/status.py`: today's dose status

**What it does.** For each dose today: `upcoming` before its time, `due` from its time, `arrived` once a
station run for that dose logged an arrival today, `acknowledged` once the person pressed "I picked it
up", `needs_attention` when not acknowledged by the dose time plus 15 minutes (`MEDHOP_GRACE_MIN`). A
dose keeps its `arrived_at` time in every status, with `arrived_mode` (`"sim"`, `"real"` or none) copied
from the arrival event. A once-a-second monitor writes `reminder_due` (only when the clock reaches the
dose time) and `needs_attention` events, at most once per dose per day.

**Known limit.** Status is per calendar day and resets at local midnight. At midnight a dose that was
never acknowledged goes back to `upcoming` for the new day, and a dose whose time plus the grace period
falls after midnight never reaches `needs_attention`.

**The one idea.** The care loop is the product and works with no drone at all. "Acknowledged" is
self-reported: a button press.

**Judge:** "Does MedHop prove the medicine was taken?"
**Answer:** No. It records that a reminder was due, that the drone (if used) arrived at the station, and
that the person pressed "I picked it up". Nothing proves a dose was taken. It is not a medical device.

### `backend/medhop/server.py` and `backend/medhop/__main__.py`: the web server

**What it does.** `python -m medhop` (run from `backend/`) starts a FastAPI server on
`http://127.0.0.1:8010`. It serves the status snapshot (`GET /api/status`, and pushed 5 times a second on
`/ws/status`), the pilot control socket (`/ws/control`, one pilot at a time; a second one is refused
with close code 4001), the annotated video (`/video.mjpg`), and REST endpoints for trim, station runs,
the hover test, arrival calibration, the schedule, acknowledgements and events. When the pilot's control
socket closes, the pilot's sticks are zeroed at once and a running station run or hover test is aborted
with `pilot_link_lost`. After a successful pilot claim the server sends `{"type":"hello","pilot":true}`,
and the page treats its control link as open only after that. Every ack and error names the command it
answers. On shutdown it aborts any run, sends neutral and never the toggle.

**The one idea.** The handlers only read snapshots and set requests; the real work happens on the
background threads, so a slow browser cannot hold up the control loop.

**Judge:** "What happens if the browser tab closes during a flight?"
**Answer:** The backend zeroes the pilot's sticks immediately and aborts a station run or hover test that
is in progress (`pilot_link_lost`), without sending the toggle. A new run cannot start until a Pilot page
is connected again (`no_pilot_link`). The drone is not landed: it gets neutral sticks, and with the tab
closed nobody can steer, land or emergency-stop it through MedHop. The checklist therefore tests the tab
closing only in the simulator and says never to close or leave the Pilot tab while the drone is in the
air. What the real drone does with neutral sticks has not been measured yet.

### `backend/tools/`: helper programs

- `make_marker.py` writes `docs/station-marker-A4.png`: the ArUco sign on A4 at 300 dpi with a 180 mm
  black square. Print at 100 % and measure.
- `fake_wifi_uav.py` is a loopback stand-in for the drone on `127.0.0.1:8800`. It sends a test picture and
  status messages, and records every packet, so the real-drone link can be tested without a drone and
  without any packet leaving the laptop.

**Judge:** "How did you test the real-drone code without flying?"
**Answer:** Against `fake_wifi_uav.py` on the loopback interface: the tests check the actual bytes sent
(neutral sticks, trim, the toggle bit sent exactly once, the emergency-stop bit, neutral on video loss,
neutral and no toggle on stop). That shows MedHop sends what it means to. It does not show how the real
drone responds.

### `backend/tests/`: the tests

Unit tests for the mixer, steering, runner, marker detection, person check, store, care status and API;
closed-loop simulator tests that fly whole station runs with drift, latency, video freezes, hidden signs,
auto-landing and pilot takeover; and the loopback tests above (skipped unless `MEDHOP_TURBODRONE_BACKEND`
is set). Run with `python -m unittest discover -s tests -t .` from `backend/`.

**Judge:** "How do you know the failsafes work?"
**Answer:** Each one has a test that triggers it in the simulator or with a fake clock and checks the
result, for example that no abort ever sends the toggle. That is evidence about the code, not about the
real drone.

---

## Frontend (`frontend/`)

**What it does.** A Vite + React + TypeScript single-page app on `http://localhost:5180` with a start
page and three app pages:

- **Start** (`/`): what MedHop is, the hospital corridor case and the results. In the browser build it
  also runs a live demo of the whole loop: one automatic station run in the simulator inside the page,
  with the Care and Caregiver side of it beside the flight.
- **Pilot** (`/pilot`): the "Camera" video, a "Pre-flight checklist" built from the status (video, station
  sign, advisory person check, light, battery raw value, emergency stop), "Manual flying" (keyboard and
  on-screen hold buttons, "Max stick" slider), "Trim", "Station run", "Hover test", "Arrival
  calibration" and "Calibrate level" panels, and a large, always visible "EMERGENCY STOP" button
  (key: Space). "Takeoff / Land (toggle)" must be held for 0.6 s (or T held); it is disabled while a
  run's landing is in progress. Keys: W/S pitch, A/D roll, arrow up/down throttle, arrow left/right yaw.
  Flight keys and Space pause only while you type in a text box; sliders, checkboxes and drop-down lists
  never block them. Switching away from the window, or the control link closing, releases every held
  input. The page shows "Drone link: connected", "Drone link: reconnecting. Commands are not reaching the
  drone." or "No reply from the drone yet. Is this laptop on the drone's Wi-Fi?", separately from the
  browser's control link. The emergency-stop banner never claims the motor cut is confirmed. Its
  headlines are "Emergency stop SENT, not confirmed", "Emergency stop NOT confirmed: the backend did not
  answer within half a second.", "Emergency stop active" (with "Motor-cut command is being sent to the
  drone."), "Emergency stop NOT delivered yet: drone link reconnecting." (the stop command has not reached
  the drone yet), "Emergency stop NOT sent: the control link is down." and "Emergency stop state unknown:
  the backend is not reachable."; an older backend without `estop_delivered` gets "Emergency stop active:
  motor-cut command sent.". The battery line shows the raw byte and its age, "No recent reading. Last:
  ..." after 3 s, and says when the check is off (verdict "Info").
- **Care** (`/care`): very large text for the older adult: the dose that is due (or the next one), a
  spoken reminder using the browser's built-in text-to-speech (turned on with "Turn on spoken
  reminders", with a mute button), and one large "I picked it up" button. When a run reached the station
  it says "The drone reached the station at HH:MM.", or "(simulator) The drone reached the station at
  HH:MM." for a simulator run.
  After "I picked it up" the button stays disabled for 3 s and the next dose is shown under "Next:". No
  drone controls.
- **Caregiver** (`/caregiver`): today's doses and their status, recent events (with the date on events
  not from today, and simulator runs labelled), simulator arrivals labelled in the doses table too
  ("Arrived at station HH:MM (simulator)"), the schedule editor ("Add dose", "Save changes"), a drone
  summary, and optional browser notifications for doses that need attention.

All wording follows the project's rules: the drone "reached the station", never anything stronger;
pickup is "acknowledged (self-reported)"; the footer says "Prototype. Demo data only. Not a medical
device. Does not confirm that medicine was taken." Open the Care and Caregiver pages in a separate
window from the Pilot page: leaving the Pilot page closes its control link and stops a run.

On every page the mode is written next to the site name: "Browser simulator",
"Python simulator" or "Real drone".

**The one idea.** In the Python build the browser is only a remote control and a display. All decisions
and failsafes are in the backend, so a frozen or closed tab cannot keep the drone flying on a held key.

**Judge:** "Is the spoken reminder AI?"
**Answer:** No. It is the browser's built-in text-to-speech (the Web Speech API) reading a fixed sentence.

### `frontend/src/transport/` and `frontend/src/engine/`: the two builds

**What it does.** `VITE_BACKEND` decides, when the site is built, which backend every page talks to
(`frontend/vite.config.ts`). `python` (the default; `npm run dev`, `npm run build`): the MedHop backend
on `http://localhost:8010`, simulator or real drone. `browser` (`npm run dev:browser`,
`npm run build:browser`): `frontend/src/engine/`, a TypeScript port of the backend's mixer, station run,
waiting for people, care store and REST routes, with the simulator, all running inside the page. A
visitor installs nothing. The hosted site on Netlify is the browser build (`frontend/netlify.toml`), and
`vite.config.ts` stops any other build there.

**The one idea.** There is no switching between the two while the site runs, on purpose: a page that was
controlling a real drone must never quietly become a simulator. The other transport is not even in the
bundle.

How the port is checked: `backend/tools/parity_traces.py` runs the Python code and records what it did
(steering, the mixer, the station run, waiting for people, the simulator, the API's answers) as fixture
files, and `backend/tests/test_parity_fixtures.py` and the frontend's Vitest suite replay them.

What is different in the browser simulator:
- The sign is not found in a picture. On the real drone and in the Python simulator, OpenCV finds it in
  the camera pixels. In the browser simulator its corners come from the simulator's own geometry, with
  noise and dropped frames added (`engine/vision/detector.ts`). The noise and the cut-offs were measured
  by running the OpenCV detector on Python simulator pictures.
- There is no advisory person check: it always reports itself off, as the Python backend does without
  local weights. Simulated people are still seen, as in the Python simulator.
- There is no real-drone link and no `/video.mjpg`: the camera picture is drawn in the page.
- The data stays in the browser's own storage, not in `data/` (see [data/README.md](../data/README.md)).

The hover test and arrival calibration are there, as in the Python simulator.

**Judge:** "Is the website flying a drone?"
**Answer:** No. The hosted site is the browser build: a simulator in the page. Only the Python build,
started on the laptop that is on the drone's Wi-Fi, can fly the real drone, and the page then says
"Real drone".

---

## Hard questions

**"Why a drone instead of a pill dispenser?"**
For most people a pill dispenser or a phone reminder would be simpler, cheaper and more reliable, and
MedHop's main part, the care loop, works with no drone at all. The drone leg is an experiment: can a
cheap camera drone make a short, supervised hop to a fixed spot, for someone who has trouble reaching
where their medicine is kept? The drone has flown station runs for real, but the project's notes do not
record a real run that went cleanly from takeoff to landing, so the honest answer today is that it is
unproven.

**"Is the person check a safety feature?"**
No. It is an advisory check that can miss people and only sees in front of the camera. Safety comes from
the rules: an empty, closed-off corridor, nobody inside, a pilot with emergency stop, no real medicine.

**"How do you know it arrived?"**
From the camera: the sign must look arrival-sized on 3 frames in a row and must have grown by 15 % since
the run first saw it, then still be in view after a 1.2 s settle. It does not measure distance in metres
and does not know whether anything was picked up.

**"What happens if Wi-Fi drops?"**
Video stops first. After 0.25 s without a frame the run holds neutral; at 0.5 s the mixer ignores the run
completely; at 1.5 s the run aborts (`video_stale`), without sending the toggle. At 3.0 s (real mode) the
mixer replaces the pilot's sticks with neutral too. After 4 s without video the turbodrone library
reconnects, and control is lost for about 5 to 9 s, including emergency stop; the page shows "Drone
link: reconnecting. Commands are not reaching the drone." A latched emergency stop is sent again as soon as the link returns. If the link is
gone completely, MedHop cannot send anything, and what this drone does then has not been tested.

**"What does emergency stop do?"**
It sends the drone's motor-cut command, and keeps sending it every control tick until reset. The drone
gives no confirmation, so the page says the command was sent and never claims the motor cut is confirmed. It only works
while the laptop, the Pilot tab, the backend and the drone link are up, and not during the library's
reconnect gap. When it works, the drone falls. That is why the checklist tests it as the first takeoff
of every session, from a very low hover over something soft.

**"How much of this did you write yourself?"**
Almost none of the code. It was written by AI coding agents (Anthropic Claude: "Claude Fable 5.2"
orchestrating and writing the backend, "Claude Opus 5.5" sub-agents writing the frontend and docs) under
my direction, from a written spec and with automated tests, including the browser build's TypeScript
port of the flight code. My part is the idea, the requirements, the hardware, all real-drone flying and
testing, and the decisions. The drone protocol work is Marshall Richards' turbodrone project; my earlier
local changes to turbodrone (2026-11-04/05) were also made with AI assistance.

**"What is AI in the product itself?"**
Only the optional YOLO11n person detector. The sign detection (ArUco) is classical computer vision and
the speech is the browser's text-to-speech.

**"What results do you have?"**
Measured figures come from the simulator and the loopback tests only, and they are labelled as such.
The drone has flown station runs for real, with no footage. In one run it hovered and did not land; in
another it found the sign from about 4 m away and then stalled on the approach, because the sign was
missing from about 45% of the camera frames. Both faults were fixed in the flight logic and the fixes
were tested in the simulator. The project's notes do not record a real run that went cleanly from
takeoff to landing. The README's real-flight table is still to be filled in.

**"Does it avoid people?"**
It waits for them, in the simulator only, and it is not a safety system. See `mission/avoid.py` above.
The real drone has never been flown near people and must not be.
