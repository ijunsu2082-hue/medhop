# MedHop

MedHop is a medication-reminder "care loop" for older adults who have trouble reaching or remembering
their medicine on time, with one experimental extra: a cheap toy camera drone that flies a short,
supervised hop along an empty corridor to a printed sign on a wall.

It is a student hackathon prototype. It uses demo data only, it is not a medical device, and nothing in
it proves that a dose was taken.

**Before any real flight, read [docs/SAFETY.md](docs/SAFETY.md) and follow
[docs/FLIGHT_CHECKLIST.md](docs/FLIGHT_CHECKLIST.md).** The drone has flown station runs for real, but
the project's notes do not record a real run that went cleanly from takeoff to landing (see "Results").

You can try MedHop without installing anything: the hosted site runs the simulator inside the page
at https://medhop.netlify.app. It cannot fly a real drone (see "Two builds of the site").

## Who it is for

- **The older adult** sees one large, simple page (`/care`): what is due, a spoken reminder, and one big
  "I picked it up" button.
- **A caregiver** enters the schedule and checks a status page (`/caregiver`): what is due, what arrived
  at the station, what was acknowledged, what needs attention.
- **A pilot** (the author) flies the experimental drone leg from the Pilot page (`/pilot`), with manual
  control and emergency stop while the laptop, the Pilot tab, the backend and the drone link are all up
  (see "Honest limits").

The start page (`/`) says what MedHop is. In the browser build (see "Two builds of the site") it also
runs a live demo of the whole loop: one automatic station run in the simulator inside the page, with the
Care and Caregiver side of it beside the flight.

## What works, what is experimental, what it does not do

**Works (tested in software, with no drone needed):**
- Caregiver-entered schedule, stored in local files.
- Reminder on the Care page, with browser text-to-speech (optional, with a mute button).
- Per-dose status for today: upcoming, due, arrived at station, acknowledged (self-reported), needs
  attention. Status is per calendar day and resets at local midnight (a known limit, see "Honest
  limits").
- A log of events: reminder due, station run started, arrived at station, run stopped early, pickup
  acknowledged (self-reported), needs attention, hover test.
- Caregiver status page with the event log and optional browser notifications.
- A simulator of the drone and its camera, used by default and by the tests.
- A browser build in which the simulator and a TypeScript port of the flight code run inside the page,
  with nothing to install (see "Two builds of the site").

**Experimental (software exists; tested in the simulator and against a loopback stand-in for the drone;
what the real drone has done so far is under "Results"):**
- The real-drone link, through the third-party turbodrone library.
- The "station run": the drone, already hovering, turns to find the printed sign, approaches it, stops
  when the sign looks big enough and logs "arrived at station". "Send the landing command on arrival (off:
  you land by hand)" is off by default, so a run ends with the drone hovering at the sign and the pilot
  lands it by hand. When it is switched on, the run sends the land command once, after a 1.2 s settle and
  only once the settle descent guard has cleared; if the guard has not cleared in time, the run skips
  the land command and the pilot lands by hand.
- Automatic station run ("Hold to fly to the station", or a dose coming due with "Fly automatically
  when a dose is due" switched on): a 5 s countdown on the ground (Stop cancels it), then the run sends
  the takeoff command itself, waits 4 s, finds the sign, flies to it with drift assist on, and always
  sends the land command on arrival. Scheduled flights only start within 90 s of the dose time, only
  after a person has pressed "Ready for the next dose" with the drone on its start spot, and only while
  a Pilot page is open (the emergency stop must stay one press away). If an automatic run stops early,
  it sends the land command only on current camera evidence that the drone is still flying (the sign
  grew since first seen, is in view now and is not rising in the picture); otherwise the page warns
  that the drone may still be in the air. Tested in the simulator only.
- Where it lands: when the sign is at least the arrive width (about 0.45 m away by the program's own
  measure with the defaults, `MEDHOP_LAND_DISTANCE_M`) on three frames in a row, after it has grown since
  it was first seen, the run starts a final line-up. Missed detections of up to 0.5 s between those
  frames do not break the row: the approach coasts on through them (the last forward stick fading to
  zero, no turning, and never forward when it is already close). The real camera lens differs from the
  program's measure, so the real distance differs: on a test run, measure where it stops with a ruler and
  put the landing spot there. Hang the sign at the drone's hover height, so it sits near the middle of
  the picture.
  From the sign's four corners it works out (classical camera geometry, `vision/pose.py`) how many
  centimetres the drone is left or right of the sign's centre line and how far from the wall. It slides
  sideways with roll, holds the distance with pitch and keeps the sign centred with yaw, and only lands
  once it has been within 4 cm of the centre line, within 8 cm of the landing distance and nearly still
  for 1 s. Through the 1.2 s settle and the landing it keeps holding that spot sideways with roll.
  Not lined up after 15 s: it lands anyway if within 12 cm (the arrival says "could not line up
  exactly"), otherwise it stops ("not_lined_up"). It also gives up if it gets 90 cm off the line or
  closer to the wall than 70 % of the landing distance (at least 30 cm). In the simulator (drone-like
  camera profile, 30 automatic runs from 2.5 m, sideways drift 0 to 0.12 m/s) every run landed within
  6 cm of the centre line and 0.35 to 0.55 m from the wall (the program's measure is exact there).
  Seeing the sign from far away only starts the approach: beyond about 5 m the 18 cm sign is too small
  to be detected, and signs with any other ArUco number are ignored.
  On the real drone the centimetres are estimates: the camera's field of view is unmeasured, which
  scales the distances (the centre line itself does not depend on it).
- Hover test (measures the peak sideways excursion while hands-off) and arrival calibration.
- Drift assist (off by default): a small, bounded roll command during the approach that counters
  sideways drift seen by the camera, and switches itself off if it makes things worse. It was added
  to the code while these docs were being written.
- The advisory person check (optional YOLO11n person detector).
- Waiting for people and obstacles ("Wait for people and obstacles" on the Pilot page, setting `avoid`,
  SPEC section 11). It only waits: something in the drone's lane (0.55 m either side of its line of
  flight) closer than 3.0 m slows it down, closer than 1.8 m makes it hold still, and closer than 0.9 m
  makes it back off a little. It carries on once the lane has been clear for 1 s. After 25 s blocked in
  all, it ends the run as `path_blocked` and lands where it is. A run is refused before takeoff when
  something stands in the lane (`obstacle_in_view`). The setting is `hold` or `off` (`MEDHOP_AVOID`):
  `hold` by default in the simulator, `off` by default on the real drone. With it off, a person the
  optional person check sees still stops the run (`person_in_view`). On the real drone only people can
  be detected, and only with that check running; without it, nothing on the drone notices people. Going around an obstacle was built, reached the station in 1 of 20
  simulated runs, and was removed (SPEC 11.8). Tested in the simulator only. It is not a safety system,
  and the real drone has never been flown near people and must not be.

**Does not do:**
- It never carries real medicine and is never flown near people.
- It does not fly back to its start spot: a person puts it back before the next automatic flight.
- An automatic flight is not unattended home use: this toy drone has no obstacle sensing, and someone
  stays in the room with the emergency stop.
- It does not prove a dose was taken. "Acknowledged" means a button was pressed.
- It does not measure position: no GPS, no distance sensor. Arrival is judged from the camera picture.
- The person check is not a safety system. It is advisory only.
- It does not go around anything in its way. Waiting for people and obstacles only slows, holds, backs
  off a little or ends the run, and it is not a safety system either.
- It does not connect to any external service, has no accounts and stores no real personal data.

## Architecture

```
frontend/  Vite + React + TypeScript, port 5180
   Start (/)              what MedHop is; a live demo in the browser build
   Pilot (/pilot)         video, keyboard and on-screen controls, EMERGENCY STOP, station run, hover test
   Care (/care)           large-type reminder, spoken reminder, "I picked it up"
   Caregiver (/caregiver) today's doses, events, schedule editor
   src/transport/         which backend the pages talk to, fixed when the site is built
   src/engine/            browser build only: the simulator and the flight code, ported to TypeScript
      |  Python build: REST, WebSockets (/ws/status, /ws/control), MJPEG (/video.mjpg)
      v
backend/medhop/  Python, FastAPI, port 8010
   server.py        HTTP and WebSocket API
   mixer.py         the only code that sends stick values to the drone; pilot always wins
   mission/         station-run state machine and failsafes; steering maths; waiting for people (avoid.py)
   vision/          ArUco sign detection (OpenCV), optional YOLO person check, annotated video
   care/            schedule, event log, today's dose status (files in data/)
   drone/sim.py     simulator (default), with simulated people and objects in drone/sim_actors.py
   drone/turbodrone.py  real drone, via a local turbodrone checkout (not copied into this repo)
```

On every page the mode is written next to the site name: "Browser
simulator", "Python simulator" or "Real drone".

The laptop does all the computing. In real-drone mode it joins the drone's own Wi-Fi network, so it has no
internet while flying. A plain-English walk through every module is in
[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md). The design contract is [docs/SPEC.md](docs/SPEC.md).

## Two builds of the site

Which backend the pages talk to is fixed when the site is built, by `VITE_BACKEND` (read in
`frontend/vite.config.ts`; the two transports are in `frontend/src/transport/`). There is no switching
between them while the site runs, on purpose: a page that was controlling a real drone must never
quietly become a simulator.

| Build | Commands (in `frontend/`) | The pages talk to | Real drone |
|---|---|---|---|
| Python (`VITE_BACKEND=python`, the default) | `npm run dev`, `npm run build` | the MedHop backend on `http://localhost:8010`, in simulator or real-drone mode | the only build that can fly it |
| Browser (`VITE_BACKEND=browser`) | `npm run dev:browser`, `npm run build:browser` | the simulator and a TypeScript port of the flight code, running inside the page (`frontend/src/engine/`) | never |

The browser build needs nothing installed for a visitor. It is what the hosted site uses: Netlify builds
it with `npm run build:browser` (`frontend/netlify.toml`), and `vite.config.ts` stops any other build on
Netlify.

**The browser engine is a port, checked against Python.** `backend/tools/parity_traces.py` records
traces from the Python code (steering, the mixer, the station run, waiting for people, the simulator and
the API's answers); `backend/tests/test_parity_fixtures.py` and the frontend's Vitest suite replay them.
One difference is deliberate: on the real drone and in the Python simulator the sign is found in the
camera picture with OpenCV, while in the browser simulator its position comes from the simulator's own
geometry, with noise and dropped frames added (`frontend/src/engine/vision/detector.ts`, whose numbers
were measured by running the OpenCV detector on Python simulator pictures).

The browser simulator has no advisory person check (it always reports it off, as the Python backend does
without local weights; simulated people are still seen, as in the Python simulator), no real-drone link
and no `/video.mjpg` stream (the camera picture is drawn in the page). The hover test and arrival
calibration are there. It keeps its data in the browser's own storage, not in `data/` (see
[data/README.md](data/README.md)).

## Quick start: simulator mode (no drone)

**Simulator inside the page (Node.js only).** Needs Node.js 22.12 or newer.

```bash
cd frontend && npm install && npm run dev:browser                       # macOS or Linux
```

```powershell
cd frontend; npm install; cd ..                                         # Windows (PowerShell)
powershell -ExecutionPolicy Bypass -File scripts\dev-sim.ps1 -Browser
```

**Python backend and simulator.** Needs Python 3.11 or newer and Node.js 22.12 or newer (Vite 8 needs
20.19+, Vitest 5 needs 22.12+). Run these from the repo folder. If `python3 --version` (on Windows,
`python --version`) prints something older than 3.11, use a newer interpreter in its place in the second
line.

macOS:

```bash
python3 --version
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements.txt
(cd frontend && npm install)
MEDHOP_PYTHON=.venv/bin/python ./scripts/dev-sim.sh
```

Windows (PowerShell; the interpreter in the virtual environment is `.venv\Scripts\python.exe`, which
`dev-sim.ps1` uses by itself when it exists):

```powershell
python --version
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
cd frontend; npm install; cd ..
powershell -ExecutionPolicy Bypass -File scripts\dev-sim.ps1
```

`dev-sim.sh` and `dev-sim.ps1` start the backend on `http://127.0.0.1:8010` and the frontend on
`http://localhost:5180`, wait until both answer, and stop both on Ctrl-C. Then open:

- Start: http://localhost:5180/
- Pilot: http://localhost:5180/pilot
- Care: http://localhost:5180/care
- Caregiver: http://localhost:5180/caregiver

The same thing by hand, in two terminals:

```bash
cd backend && ../.venv/bin/python -m medhop      # macOS, terminal 1: backend, port 8010
cd frontend && npm run dev                       # macOS, terminal 2: frontend, port 5180
```

```powershell
cd backend; ..\.venv\Scripts\python.exe -m medhop   # Windows, terminal 1: backend, port 8010
cd frontend; npm run dev                            # Windows, terminal 2: frontend, port 5180
```

On first start the backend creates `data/` files with three doses labelled "(demo)". See
[data/README.md](data/README.md).

### Tests

```bash
.venv/bin/python -m pip install httpx            # needed by the API tests
(cd backend && ../.venv/bin/python -m unittest discover -s tests -t .)
(cd frontend && npm test)
```

```powershell
.venv\Scripts\python.exe -m pip install httpx
cd backend; ..\.venv\Scripts\python.exe -m unittest discover -s tests -t .; cd ..
cd frontend; npm test; cd ..
```

The backend suite includes closed-loop simulator runs and takes several minutes. The loopback tests of
the real-drone link are skipped unless `MEDHOP_TURBODRONE_BACKEND` is set (see below); they talk only to
`backend/tools/fake_wifi_uav.py` on 127.0.0.1.

## Real-drone mode

**Read [docs/SAFETY.md](docs/SAFETY.md) and follow [docs/FLIGHT_CHECKLIST.md](docs/FLIGHT_CHECKLIST.md)
step by step. Emergency stop sends the motor-cut command; when it reaches the drone, the drone falls.**

The drone: a toy camera drone sold as "AXNEN i1". It reports firmware
`(FLOW)FLOW_720P_V1.4.16_20241227_Beta(C22)`, uses the "WiFi UAV" phone app and a Wi-Fi network named
`FLOW_xxxxxx`, and has no GPS. Its forward camera streams 640x360 JPEG at about 15 fps, with roughly 0.4
to 0.5 s from command to video. The manufacturer publishes no payload, weight, battery or flight-time
figures that the author could find.

The drone has no official SDK. MedHop talks to it through
[turbodrone](https://github.com/marshallrichards/turbodrone) (Apache-2.0, Marshall Richards), which
reverse-engineered the phone app's protocol. MedHop does not copy turbodrone: it imports it from a local
checkout. **Real-drone mode needs the author's modified turbodrone checkout**, not upstream turbodrone
alone: for example, the telemetry hook MedHop uses and the `calibrate_gyro` call behind "Calibrate
level" exist only in the modified checkout, and so does the way the takeoff/land, stop and calibrate
commands are held and repeated. Those changes are uncommitted and unpublished. See
[docs/PROVENANCE.md](docs/PROVENANCE.md) for the full list.

1. **While you still have internet**, install the optional person check and download its weights (the
   laptop has no internet once it is on the drone's Wi-Fi, and MedHop never downloads anything at run
   time):

   ```bash
   .venv/bin/python -m pip install ultralytics
   .venv/bin/python -c "from ultralytics import YOLO; YOLO('yolo11n.pt')"   # saves yolo11n.pt in the current folder
   ```

   On Windows the interpreter is `.venv\Scripts\python.exe` in the same two lines.

   This is optional. Without it the person check reports itself as off and everything else works.
2. Power on the drone and join the laptop to its `FLOW_xxxxxx` Wi-Fi network.
3. Start:

   ```bash
   export MEDHOP_PYTHON=.venv/bin/python
   export MEDHOP_TURBODRONE_BACKEND=/path/to/turbodrone/backend
   export MEDHOP_YOLO_WEIGHTS="$PWD/yolo11n.pt"        # optional
   ./scripts/fly-real.sh
   ```

   `fly-real.sh` refuses to start if `MEDHOP_TURBODRONE_BACKEND` is missing or wrong, if
   `MEDHOP_YOLO_WEIGHTS` points at a missing file, if ports 8010 or 5180 are in use, or if turbodrone's
   own web server looks to be running (something listening on port 8000, or a process matching
   `web_server`). Only one program may control the drone, so also close the WiFi UAV phone app. It
   prints a safety reminder and starts only after you type `yes`, then prints the Pilot page's address,
   `http://localhost:5180/pilot`. It always starts the Python build of the site.

   `fly-real.sh` is a macOS shell script. There is no Windows start script for real-drone mode.

### Settings (environment variables, all optional except where noted)

| Variable | Default | Meaning |
|---|---|---|
| `MEDHOP_DRONE` | `sim` | `sim` or `real` (the scripts set it for you) |
| `MEDHOP_TURBODRONE_BACKEND` | none | path to turbodrone's `backend/` directory (required for `real`) |
| `MEDHOP_DRONE_IP` | `192.168.169.1` | drone address in real mode |
| `MEDHOP_CONTROL_RATE` | `20` | control packets per second |
| `MEDHOP_DATA_DIR` | `data/` in the repo | schedule, events, trim, calibration, run traces |
| `MEDHOP_MARKER_ID` | `7` | ArUco id of the station sign |
| `MEDHOP_MARKER_SIZE_M` | `0.18` | measured edge of the printed black square, in metres (used for the hover-test drift estimate) |
| `MEDHOP_LAND_DISTANCE_M` | `0.45` | landing distance in front of the sign, in metres by the program's own measure (worked out from `MEDHOP_CAMERA_HFOV_DEG` and `MEDHOP_MARKER_SIZE_M`; 0.35 to 3.0). The real lens differs, so the real distance differs: measure it with a ruler and put the landing spot there. Hang the sign at the drone's hover height, so it sits near the middle of the picture |
| `MEDHOP_ARRIVE_WIDTH` | derived from `MEDHOP_LAND_DISTANCE_M` | sign width, as a fraction of the frame width, that counts as arrived (0.286 with the defaults). Set it to override the landing distance; arrival calibration overrides both |
| `MEDHOP_PERSON_CHECK` | `auto` | `auto` (on if ultralytics and weights are available), `on` (refuse to start without them), `off` |
| `MEDHOP_YOLO_WEIGHTS` | none | local path to `yolo11n.pt` |
| `MEDHOP_BATTERY_LOW_RAW` | `-1` | raw battery byte at or below which the battery counts as low. `-1` switches the check **off** (the default), because the byte's meaning is not verified |
| `MEDHOP_HOVER_MAX_EXCURSION_M` | `0.5` | hover-test pass limit for the peak sideways excursion, in metres (an estimate) |
| `MEDHOP_GRACE_MIN` | `15` | minutes after a dose time before it "needs attention" |
| `MEDHOP_CAMERA_HFOV_DEG` | `70` | camera field of view, for the "sign about X m away" estimate and for turning `MEDHOP_LAND_DISTANCE_M` into the arrive width (unmeasured on the real drone) |
| `MEDHOP_HOST` | `127.0.0.1` | address the backend listens on |
| `MEDHOP_SIM_CAMERA` | `high` | simulator only: `high` (a rendered room at 1280x720, 15 fps, a clearer picture than the real camera gives; starts 3.2 m from the sign) or `drone` (the drone-like 640x360 profile with noise, blur and JPEG quality 50 that the simulator closed-loop tests and the published figures use) |
| `MEDHOP_AVOID` | `hold` in the simulator, `off` on the real drone | waiting for people and obstacles: `hold` or `off` (anything else is refused at startup). The Pilot page's "Wait for people and obstacles" switch is stored in `data/mission.json` and wins over this |
| `MEDHOP_PYTHON` | `python3` (`dev-sim.ps1`: `.venv\Scripts\python.exe` if it exists, otherwise `python`) | interpreter used by the scripts in `scripts/` |
| `VITE_BACKEND` | `python` | frontend, fixed when the site is built: `python` or `browser` (see "Two builds of the site"). `npm run dev:browser` and `npm run build:browser` set `browser`; any other value stops the build |
| `VITE_API_BASE` | `http://localhost:8010` | frontend, Python build only: the backend's address |

The station sign is `docs/station-marker-A4.png` (ArUco DICT_4X4_50, id 7, 180 mm black square on A4).
Print it at 100 % and measure it; `backend/tools/make_marker.py` makes other sizes.

## Honest limits

- **No clean real run is on record.** The drone has flown station runs for real, and there is no
  footage of them. In one run it hovered and did not land. In another it found the sign from about 4 m
  away and then stalled on the approach, because the sign was missing from about 45% of the camera
  frames. Both faults were fixed in the flight logic and the fixes were tested in the simulator.
  The project's notes do not record a real run that went cleanly from takeoff to landing. All the
  figures in this README come from the simulator and from a loopback stand-in for the drone, and
  simulator results are not flight results.
- The drone leg is short, supervised, in an empty closed-off corridor, and carries no real medicine.
- The takeoff and land commands are one shared toggle on this drone. Pressing it when the drone has
  already landed by itself makes it take off again.
- Emergency stop needs the laptop, the Pilot browser tab, the backend and the drone link all up. While
  it is latched the backend keeps sending the motor-cut command every control tick. The drone gives no
  confirmation, so the page reports the command as sent and never claims the motor cut is confirmed.
  If the drone link is reconnecting, the banner says "Emergency stop NOT delivered yet: drone link
  reconnecting." ("delivered" there refers to the stop command only).
- If the laptop, browser or Wi-Fi fails, MedHop cannot send anything, including emergency stop, and what
  this drone does then has not been tested. After 4 s without video the turbodrone library reconnects and
  control is lost for about 5 to 9 s; nothing reaches the drone in that gap. A latched emergency stop is
  sent as soon as the link returns. In real mode the pilot's sticks are replaced by neutral once video is
  3 s old, so the last stick packets before that gap are neutral.
- Closing or leaving the Pilot page stops a running station run (`pilot_link_lost`), and a run cannot
  start without a connected Pilot page (`no_pilot_link`). It does not land the drone. Open the Care and
  Caregiver pages in a separate window.
- No GPS and no position sensing: the station run steers by the camera picture only. Sideways drift is
  countered only by roll trim and by the experimental drift assist, if switched on (off by default; its
  roll is capped at 0.15 of full stick and applies only during the approach). The real drift is unknown.
  In the simulator (Revision 3 build, 2026-11-11, 10 seeds, start 2.5 m, 0.45 s latency, drone-like
  camera profile; not flight results; not repeated on this build), with +0.08 m/s of simulated drift, runs ended 0.53 to 0.79 m (mean
  0.64 m) off the sign's axis with the assist off and 0.13 to 0.26 m (mean 0.17 m) with it on; with
  +0.20 m/s they ended 0.75 to 0.99 m (mean 0.84 m) off axis even with it on. If the roll
  direction is wrong on the real drone, the assist makes things worse for 3 to 5 s before it switches
  itself off. A camera-only estimate cannot tell a slow turn from a sideways slide at range. The drift
  assist has not been tried on the real drone. Set roll trim first.
- Battery and status values from the drone are raw bytes whose meanings are not verified. The battery
  check is off by default.
- The person check can miss people and only sees in front of the camera.
- Waiting for people and obstacles is tested in the simulator only, where every simulated person and
  object is reported exactly: a perfect detector, which no real detector is. On the real drone it is off
  by default and can only ever know about people the optional person check sees. It is not a safety
  system. The real drone has never been flown near people and must not be.
- "Arrived at station" means the camera saw the sign at arrival size after the drone moved toward it. It
  does not mean anything was picked up. "Acknowledged" is self-reported. The Care page says "The drone
  reached the station at HH:MM.", or "(simulator) The drone reached the station at HH:MM." for a
  simulator run. Simulator arrivals are also labelled on the Caregiver page.
- The sign must be at least about 25 px wide in the picture for reliable detection (detections under
  0.025 of the frame width are ignored), and a run starts approaching only after 3 detections in a row. In the simulator this
  cut-off ends detection at about 4.7 m (simulator figure only).
  The real start distance has to be measured (checklist section C).
- Care status is per calendar day and resets at local midnight: an unacknowledged dose goes back to
  "upcoming" for the new day, and a dose whose time plus the grace period falls after midnight never
  reaches "needs attention".
- Demo data only. Not a medical device.

## Results

### Real flights

*To be filled in by the author from the run log in docs/FLIGHT_CHECKLIST.md.*

What is known so far, and no more: the drone has flown station runs for real; there is no footage. In
one run it hovered and did not land. In another it found the sign from about 4 m away and then stalled
on the approach, because the sign was missing from about 45% of the camera frames. Both faults were
fixed in the flight logic, and the fixes were tested in the simulator. The project's notes do not record
a real run that went cleanly from takeoff to landing.

| Measure | Value |
|---|---|
| Station runs attempted | |
| Arrived at station | |
| Aborted: `marker_not_found` | |
| Aborted: `marker_lost` | |
| Aborted: `off_axis` | |
| Aborted: `unexpected_descent` | |
| Aborted: `video_stale` | |
| Aborted: `timeout` | |
| Aborted: `pilot_took_over` | |
| Aborted: `pilot_link_lost` | |
| Aborted: `person_in_view` | |
| Ended: `path_blocked` | |
| Aborted: `battery_low` | |
| Aborted: `estop` | |
| Start refused, per blocker (see the blocker table in [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)) | |
| Hover test: peak sideways excursion estimate (m), per test | |
| Hover test: passed / run | |
| Person check: frames or trials with a person in view / detected | |
| Person check: trials with nobody in view / false detections | |

### Simulator (not flight results)

These numbers come from the simulator in `backend/medhop/drone/sim.py` and from the test suites, not
from the real drone. These figures, and the simulator closed-loop and marker tests, use the Python
simulator's drone-like camera profile (`tests/test_sim_high_quality.py` covers the display profile, and
a test that builds the app from default settings, for example in `tests/test_automatic.py`, also runs
on it). The interactive Python simulator (`dev-sim.sh`, `dev-sim.ps1`) uses the display profile by
default instead: a rendered room at 1280x720 that starts 3.2 m from the sign, so the sign is in view from
the ground. Its picture is cleaner than the real camera's, so it is not a guide to how well the real
camera sees the sign. The browser simulator does not look for the sign in a picture at all (see "Two
builds of the site").

These are simulator results, not real-drone results. They were measured on this build on 2026-11-13
with `backend/tests/test_avoid_sim.py` (its `fly()` helper): automatic runs from the ground, seeds 0 to
19 (20 runs per row), the drone-like camera profile (640x360, noise, blur, JPEG quality 50), a sideways
drift of 0.08 m/s and a start heading 5 degrees off (each to one side or the other, depending on the
seed), and waiting for people and obstacles set to `hold`. Distances to people are simulator truth: the smallest
horizontal distance from the simulated drone to any simulated person while flying.

| Corridor | Start | Outcome | Details |
|---|---|---|---|
| Empty | 2.5 m | 20 of 20 landed at the station | landed 0.35 to 0.50 m from the wall (mean 0.43), at most 0.04 m off the centre line; 27 to 37 s per run (mean 32.5) |
| A person walks across | 4.2 m | 20 of 20 waited, then landed at the station | waited at least 3.2 s; never closer than 1.17 m to the person; 42 to 52 s per run (mean 44.9) |
| A person stands in the way | 4.2 m | 20 of 20 ended `path_blocked` and landed where they were | never closer than 1.77 m; 37 to 52 s |
| Three people block the corridor | 4.2 m | 20 of 20 ended `path_blocked` and landed where they were | never closer than 1.10 m; 39 to 40 s |

To reproduce them, from `backend/`:

```bash
MEDHOP_LONG_TESTS=1 ../.venv/bin/python -m unittest tests.test_avoid_sim          # macOS
```

```powershell
$env:MEDHOP_LONG_TESTS = "1"; ..\.venv\Scripts\python.exe -m unittest tests.test_avoid_sim   # Windows
```

Without `MEDHOP_LONG_TESTS=1` the test runs only the first 3 seeds. With a trolley standing in the lane,
every start is refused before takeoff (`obstacle_in_view`). In Chrome, the start page's demo of an
empty-corridor run in the browser simulator takes about 35 s from the press to landed at normal speed (33 to 38 s over four runs).

Known limits: the simulator reports every simulated person exactly, which no real detector does, and
none of this has been tried on the real drone. An earlier simulator table of the drift assist (Revision 3
build, 2026-11-11) is summarised under "Honest limits".

## AI disclosure

Almost all of MedHop's code was written by AI coding agents (Anthropic Claude: "Claude Fable 5.2"
orchestrating and writing the backend, "Claude Opus 5.5" sub-agents writing the frontend and these docs)
under the author's direction, from a written spec and with automated tests. That includes the browser
build's TypeScript port of the flight code, which was checked against traces recorded from the Python
code. The author's role is the idea, the requirements, the hardware, all real-drone flying and testing
(see "Results" for what has been flown), and the decisions.

The only AI model inside the running product is the optional, pretrained YOLO11n person detector
(Ultralytics), used as an advisory person check. The station-sign detection is ArUco via OpenCV, which is
classical computer vision. The spoken reminder uses the browser's built-in text-to-speech (Web Speech
API).

The author's earlier local changes to turbodrone (2026-11-04 and 2026-11-05, before MedHop) were also made
with AI coding assistance; see [docs/PROVENANCE.md](docs/PROVENANCE.md).

## Third-party credits and licences

| Project | Used for | Licence |
|---|---|---|
| [turbodrone](https://github.com/marshallrichards/turbodrone) by Marshall Richards | the real-drone protocol (imported from a local checkout, not copied here) | Apache-2.0 |
| [OpenCV](https://opencv.org/) (via the `opencv-python` package) | ArUco sign detection, image handling | Apache-2.0 |
| [Ultralytics](https://github.com/ultralytics/ultralytics) YOLO11n | optional advisory person check (not installed by default) | AGPL-3.0 |
| [FastAPI](https://fastapi.tiangolo.com/) | backend web framework | MIT |
| [Uvicorn](https://www.uvicorn.org/) | backend server | BSD-3-Clause |
| [NumPy](https://numpy.org/) | numerics | BSD-3-Clause |
| [React](https://react.dev/) and React Router | frontend | MIT |
| [Vite](https://vite.dev/) and Vitest | frontend build, dev server and tests | MIT |
| [TypeScript](https://www.typescriptlang.org/) | frontend language | Apache-2.0 |
| Atkinson Hyperlegible Next by the Braille Institute (via the `@fontsource-variable` package) | the site's one typeface, self-hosted | SIL Open Font License 1.1 |

If the optional Ultralytics package is installed and used, its AGPL-3.0 terms apply to that use.

## Provenance

MedHop's repo was created on 2026-11-11 and all code in it was written from that date. The git history
of this repo starts on the day of its first commit and is the record of when MedHop code was written. It
builds on work that existed before:

- **turbodrone** (third-party): 70 commits in its public history between April 2025 and June 2026, by
  Marshall Richards (64) and three other contributors (6).
- **The author's own local changes inside their turbodrone checkout**, made on 2026-11-04 and 2026-11-05
  with AI coding assistance, before MedHop started: fixes that made takeoff/land commands reliable on this
  drone, MCU status message logging, a person-follow plugin rewrite, a browser UI redesign and a video
  recorder. Those changes live in the turbodrone checkout, uncommitted, not in this repo. MedHop's
  real-drone mode depends on that modified checkout (on `calibrate_gyro`, the command hold logic, the
  status-message hook and the command carried in video requests; the full list is in PROVENANCE) and
  does not run against unmodified upstream turbodrone. Simulator mode needs no turbodrone at all. None
  of the follow plugin, UI or recorder code is used by MedHop.

Details, dates and how to check them: [docs/PROVENANCE.md](docs/PROVENANCE.md).

## Cross-submission statement

The author intends to enter this same project in DSH Hacks V2, IceHacks, STEMergent Hacks and the
STEM2Connect AI Hackathon, and states that openly here.

For IceHacks (build period 8 to 15 November 2026 *[author: add a link to the IceHacks rules that state
this period]*): the author asked the IceHacks organisers on Discord about building on the pre-existing
drone-control work described above and reports that they approved it.
*[author: add a screenshot or link to that Discord message here.]*

What is known and not known for each event is in [docs/PROVENANCE.md](docs/PROVENANCE.md). Nothing here
claims that MedHop is eligible for any event; that is for each event's organisers to decide.

## Licence

Licence: to be chosen by the author.
