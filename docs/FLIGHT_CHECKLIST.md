# MedHop flight checklist

Work through this in order, ticking each box. Read [SAFETY.md](SAFETY.md) first. Every test ends with a
**GO** line and a **NO-GO** line. NO-GO means stop: land (or leave the drone on the floor), power off, and
fix the cause before flying again.

Names in "quotes" are the button and label texts on the Pilot page (`http://localhost:5180/`).

Nothing in MedHop has been flown on the real drone yet, so the first session is also the first real test
of the software. Go slowly, and write down what really happens in the logs at the end (sections J and L).

> **Does the drone scan the room?** No. It does not map or scan the room, and it does not know where it
> is. In a station run it looks for one thing only: the printed station sign (an ArUco marker, found with
> classical computer vision, not AI). It turns slowly until it sees the sign, then flies toward it until
> the sign looks big enough. It does not see walls, people or obstacles. The optional advisory person
> check can miss people and is not a safety system.

> **Emergency stop has limits.** It only works while the laptop, the Pilot browser tab, the MedHop
> backend and the drone's Wi-Fi link are all up. The drone sends no confirmation, so the page can only
> say the motor-cut command was sent; you confirm by eye that the motors stopped. During the turbodrone
> library's 5 to 9 s reconnect gap nothing reaches the drone, including emergency stop. See SAFETY.md
> section 2.

---

## A. Setup and people rules

### People and place (every session)

- [ ] 1. Rules from SAFETY.md section 1, every time: empty, closed-off indoor corridor; nobody and no pets
      inside the barrier while the drone is powered (the only exception is motors-off handling with
      emergency stop latched, in sections C and G); eye protection for everyone; an adult present; no
      real medicine. Never fly near an older adult or any bystander.
- [ ] 2. Corridor: straight, empty floor, nothing hanging down, at least 1 m longer than the start
      distance you will set in section C.
- [ ] 3. Measure the corridor's free width at its narrowest point along the flight line (wall to wall, or
      to the nearest thing sticking out). Then measure from the line you will fly along to the nearer
      wall or obstacle. Write both down; step 40 uses the second number.
      Free width: ______ m. Free space to the nearer wall (S): ______ m.
- [ ] 4. Physical barrier at both ends, with a "do not enter" sign on it.
- [ ] 5. Lighting: bright, even light. A textured, non-shiny floor. No direct sunlight on the floor.
- [ ] 6. Prop guards fitted (if the drone has them). Propellers undamaged.
- [ ] 7. Batteries charged, and numbered (write the number on each with a marker). Laptop charged,
      plugged in if possible, and sleep turned off.

### The station sign (once, and again if you move it)

- [ ] 8. Print `docs/station-marker-A4.png` on A4 paper at **100 % scale** ("Actual size". Do not use
      "Fit to page").
- [ ] 9. Measure the black square with a ruler. It should be **180 mm** on each side.
      - If it is not, either reprint at the correct scale, or start the backend with
        `MEDHOP_MARKER_SIZE_M` set to what you measured, in metres (for example `0.176`). This number is
        only used to turn the hover test's measurement into metres.
- [ ] 10. Mount the sign **flat** on the wall at the end of the corridor, with the centre of the black
      square at about the height you expect the camera to hover at. You will check this height in step 36.
      Tape all four corners so the paper does not curl. Avoid glare: no lamp or window reflecting off the
      sheet.

### The laptop (once per session, before the drone is switched on)

- [ ] 11. While you still have internet, install everything (README "Quick start") and, if you want the
      advisory person check, download the YOLO weights (README "Real-drone mode"). Nothing can be
      downloaded later: on the drone's Wi-Fi the laptop has no internet.
- [ ] 12. **Pilot-link test in the simulator** (once, before the first real session, and after any
      software update; no drone involved). Start `MEDHOP_PYTHON=.venv/bin/python ./scripts/dev-sim.sh`,
      open the Pilot page, take off in the simulator with "Takeoff / Land (toggle)", tick "The drone is
      hovering and the corridor is empty", and press "Start station run". Within a few seconds, close
      the Pilot tab. In a terminal run
      `curl -s http://127.0.0.1:8010/api/status | grep -o 'no_pilot_link\|pilot_link_lost'`.
      Then reopen `http://localhost:5180/` and look at the "Station run" panel. Stop `dev-sim.sh` with
      Ctrl-C.
      **GO:** the curl line prints `pilot_link_lost` and `no_pilot_link`, and the reopened page shows the
      run stopped because the pilot window lost its control link.
      **NO-GO:** the run was still going after the tab closed. The software does not match these docs. Do
      not fly.
- [ ] 13. Know what this means in a real flight. Closing the Pilot tab stops a station run, but it does
      not land the drone: the backend keeps sending neutral sticks and nobody can steer, land or
      emergency-stop the drone through MedHop until a Pilot page is connected again. If the laptop itself
      sleeps, crashes or leaves the drone's Wi-Fi, MedHop sends nothing at all. In both cases the software
      can do nothing more; the pilot must use the drone's own handheld remote or wait for the drone to come
      down. `[author: confirm the handheld remote works as a backup while the laptop is connected]` Until
      that has been confirmed on the ground, do not count on the remote. Never close or navigate away from
      the Pilot tab while the drone is in the air.
- [ ] 14. **Only one controller may talk to the drone.** Quit turbodrone's own server (port 8000) and its
      frontend, and close the WiFi UAV phone app on every phone (swipe it away, do not just switch apps).
      `fly-real.sh` refuses to start while turbodrone's server is running, but it cannot see the phone
      app.
- [ ] 15. Power on the drone, on the floor. Join the laptop to the drone's Wi-Fi network (named `FLOW_`
      followed by some characters).
- [ ] 16. Start MedHop in real-drone mode from the repo folder:

      ```bash
      export MEDHOP_PYTHON=/path/to/python3.11-or-newer
      export MEDHOP_TURBODRONE_BACKEND=/path/to/turbodrone/backend
      export MEDHOP_YOLO_WEIGHTS=/path/to/yolo11n.pt   # optional
      ./scripts/fly-real.sh
      ```

      Read the safety reminder, then type `yes`.
- [ ] 17. Open `http://localhost:5180/` (the Pilot page) in its own browser window. Open the Care and
      Caregiver pages only in a **separate** window, never by clicking to them in the Pilot tab: leaving
      the Pilot page closes its control link, which stops a run and removes emergency stop.
- [ ] 18. Close every other MedHop Pilot tab. (A second one shows "Another pilot window is connected.")
- [ ] 19. Click once on an empty part of the Pilot page so it has keyboard focus. The keys, including
      Space for emergency stop, only work while this page has focus.

---

## B. Ground checks, motors off (every session)

The drone sits on the floor with its motors off. Nobody touches it. Everyone is behind the barrier.

- [ ] 20. The top of the Pilot page shows "Mode: real drone", "Control link: connected" and
      "Drone link: connected". If it says "No reply from the drone yet. Is this laptop on the drone's
      Wi-Fi?", the laptop is probably not on the drone's Wi-Fi.
- [ ] 21. The "Camera" panel shows the drone's live picture, and the "Video" checklist row shows Live.
- [ ] 22. The "Keys paused while you type in a text field: ..." line is **not** showing. (Flight keys pause only while you are typing
      in a text box. Sliders, checkboxes and drop-down lists do not pause them.)
- [ ] 23. Set "Max stick" to **0.20** (its lowest setting). Tap W once. The page shows "Backend sees
      manual input: yes" for a moment. With the motors off nothing should move. If the motors start,
      press Space at once: NO-GO.
- [ ] 24. Press Space once. The emergency-stop banner appears ("Emergency stop SENT, not confirmed", then
      "Emergency stop active" with "Motor-cut command is being sent to the drone.") and the "Emergency
      stop" checklist row shows Active. The page only says the command is being sent, because the drone
      does not confirm the motor cut.
- [ ] 25. Press "Reset emergency stop". The banner goes away and the "Emergency stop" row shows Not
      active.
- [ ] 26. "Battery" shows a raw byte and its age, and says the check is off (the default). Write the byte
      in the battery log (section J).

**GO:** every line above as described. **NO-GO:** any line different, or the banner says "Emergency stop
NOT delivered yet: drone link reconnecting." and "Drone link" does not return to connected. Do not take
off.

---

## C. Motors-off range check for the sign (once per sign position and lighting)

This finds how far away the real camera can still see the sign. The old hint of a 2.5 m start came from
the simulator's assumed 70-degree camera; the real camera's field of view has not been measured, so
measure the range instead.

- [ ] 27. Press "EMERGENCY STOP" (or Space) and leave it latched. While it is latched, MedHop refuses the
      takeoff/land toggle, so the drone cannot be launched while someone holds it. This needs two people
      (one holds the drone, one watches the laptop), or one person carrying the laptop with the Pilot page
      in front.
- [ ] 28. Hold the drone by hand with the motors **off** and fingers clear of the propellers, camera level
      with the centre of the sign and facing it squarely. Start about 1 m from the sign and walk slowly
      back along the flight line, watching the "Station sign" checklist row. Note the distance where it
      stops being steadily "In view" (it starts to flicker to "Not in view"), and the width it showed
      just before.
      Range D: ______ m. Width at D: ______ of frame.
- [ ] 29. Set your start distance to **at most 70 % of D**, and check that at that distance the sign's
      width reads at least **0.05** on the page. (The page shows two decimals; this is about 0.045 of the
      frame width, about 28 px of the 640 px picture. MedHop ignores signs narrower than 0.025 of the
      frame, and detection is only reliable from about 25 px.) If the width is lower, move closer until
      it reads 0.05. Put the drone down at the takeoff spot, everyone back behind the barrier, then press
      "Reset emergency stop".
      Start distance: ______ m. Width there: ______.

**GO:** start distance and width written down. **NO-GO:** the sign is never steadily in view: check the
light, the glare and the print, and do not fly station runs until it is.

---

## D. First takeoff: emergency-stop test (every session, before any other flight)

Nothing else flies until this has passed today.

- [ ] 30. Put something soft under the drone (a mattress or thick foam). "Max stick" at 0.20. The
      "Keys paused while you type in a text field: ..." line is not showing. Everyone behind the barrier. Look at the drone: it is on
      the ground.
- [ ] 31. Hold "Takeoff / Land (toggle)" for 0.6 s (or hold T). As soon as the drone has lifted off,
      keep it **as low as you can** over the soft surface and press "EMERGENCY STOP" (or Space).
      **GO:** the motors stop at once, the drone drops onto the soft surface, and the banner says
      "Emergency stop active" with "Motor-cut command is being sent to the drone.".
      **NO-GO:** the motors keep running, or the banner says "Emergency stop NOT delivered yet: drone
      link reconnecting.". While emergency stop is
      latched MedHop holds neutral sticks and refuses the toggle, so if the drone is still flying: press
      "Reset emergency stop", look at the drone, and land it with "Takeoff / Land (toggle)". Then power
      the drone off and do not fly with MedHop until the stop works.
- [ ] 32. Leave emergency stop latched while someone checks the drone and propellers (motors off). Then
      everyone back behind the barrier, and press "Reset emergency stop".

## E. Manual control test (every session)

- [ ] 33. "Max stick" at 0.20. The "Keys paused while you type in a text field: ..." line is not showing. Look at the drone, then take
      off: hold "Takeoff / Land (toggle)" for 0.6 s (or hold T). Let it settle.
- [ ] 34. Tap each key briefly, one at a time, and watch the drone:

      | Key | Should move the drone | Correct? |
      |---|---|---|
      | W | forward | [ ] |
      | S | back | [ ] |
      | A | left | [ ] |
      | D | right | [ ] |
      | Arrow up | up | [ ] |
      | Arrow down | down | [ ] |
      | Arrow left | turn left | [ ] |
      | Arrow right | turn right | [ ] |

      **GO:** every key moves the drone the labelled way.
      **NO-GO: if ANY direction is reversed, stop.** Land. Do not use station runs or drift assist on
      this drone until it is fixed: the station run steers with the same signs, so it would steer the
      wrong way.
- [ ] 35. Land: look at the drone, then hold "Takeoff / Land (toggle)" for 0.6 s while it is in the air.

## F. Hover height and hover test (every session)

- [ ] 36. Hover height: take off, let the drone settle without touching the controls, and note how high
      above the floor the **camera** sits. Land. If the sign's centre is not at that height, move the sign
      (drone landed, motors off). If the light on the sign changed, repeat section C.
      Camera hover height: ______ m.
- [ ] 37. Take off. Hover facing the sign at your start distance (section C), with the "Station sign"
      checklist row showing In view.
- [ ] 38. Press "Start hover test". Take your hands off the keys for 10 s, but stay ready to press Space.
- [ ] 39. Read the result. It reports the **peak** sideways excursion during the 10 s (the largest
      side-to-side spread of the sign's position, turned into metres with the printed sign size; it is an
      estimate) and the limit (0.5 m by default, `MEDHOP_HOVER_MAX_EXCURSION_M`). **Pass** means the peak
      excursion is within the limit and the sign was visible at least 80 % of the time.
      Peak excursion P: ______ m.
- [ ] 40. Corridor check. Scale P to the length of a run: P_run = P x (T / 10), where T is the run time
      in seconds. Until you have timed a real run, use T = 45 (the run timeout, the longest a run can
      last); after that, use the longest run time in your log.
      P_run: ______ m. Half of S (step 3): ______ m.
      **GO:** P_run is at most half of S. **NO-GO:** P_run is more than half of S. Do not do station runs
      in this corridor: trim and repeat the hover test, fly the hop by hand, or use a wider space.
- [ ] 41. If the hover test shows **Fail**: use the "Trim" panel ("Drifting right? Tap Trim left. Drifting
      forward? Tap Trim back."), a step or two at a time, then repeat the hover test. If it still fails
      after a few rounds of trim, do not use station runs today. Fly the hop by hand and note "manual" in
      the run log.
- [ ] 42. Land.

---

## G. Arrival calibration (once per sign position)

This sets how big the sign must look for "arrived". It needs a person next to the drone, so the
takeoff toggle must be locked first.

- [ ] 43. Drone landed, motors off. Press "EMERGENCY STOP" (or Space) and leave it latched, so the
      takeoff/land toggle is refused. Two people (one holds the drone, one at the laptop), or one person
      carrying the laptop with the Pilot page in front.
- [ ] 44. Hold the drone by hand, motors off, fingers clear of the propellers, camera level with the sign
      centre and facing it squarely, at the distance where you want it to stop. **For the first runs this
      is at least 1.0 m from the wall sign.** Shorten it only after you have measured, in runs with the landing
      command on arrival off, how far the drone travels past the point where it reports arrival.
      Stopping distance: ______ m.
- [ ] 45. In the "Arrival calibration" panel press "Set arrival distance from current view". It shows
      "Saved." and the new "Arrive width now" value.
- [ ] 46. Still latched: hold the drone at your start distance at sign height (not on the floor). The
      "Station sign" row should say In view, not "already at or above arrive width". If it does, start
      further back.
- [ ] 47. Put the drone down at the takeoff spot. Everyone back behind the barrier. **Only then** press
      "Reset emergency stop".

## H. Station runs

### How landing works in a run

The drone has **one shared takeoff/land toggle**: on the ground it takes off, in the air it lands.
"Send the landing command on arrival (off: you land by hand)" is **off by default**, so a station run
ends with the drone hovering at the sign and the pilot lands it by hand. The setting is remembered across
backend restarts, so check it before every run. When it is on, the run holds still for the 1.2 s settle
and sends the toggle once after a confirmed arrival, but only after the settle descent guard has cleared;
if the guard has not cleared within 1.0 s after the settle, the run skips the toggle, ends "Done", and you
land by hand. While the run is in its landing state the page disables "Takeoff / Land (toggle)" and shows
"Landing in progress", and for 4 s after the run's toggle the backend refuses a pilot toggle, because a
second toggle just after the drone has landed would make it take off again.

### Before every takeoff

- [ ] 48. "Drone link: connected", "Video" Live, "Emergency stop" Not active, and the "Keys paused while you
      type in a text field: ..." line is not showing (if it is, click an empty part of the page).

### H1. First station runs, with the landing command on arrival OFF

- [ ] 49. In the "Station run" panel, check that "Send the landing command on arrival (off: you land
      by hand)" is unticked.
- [ ] 50. In step 3 of the "Station run" panel, leave "Which dose is this run for?" on "No dose (practice run)".
- [ ] 51. Look at the drone, take off, and hover facing the sign at your start distance. Corridor empty.
- [ ] 52. Tick "The drone is hovering and the corridor is empty".
- [ ] 53. Check that the "Before you can start:" list above the button is gone, then press "Start station run".
      Keep your hands at the keys.
- [ ] 54. To stop at any time: press any flight key (the run hands control back to you), or "Abort run",
      or "EMERGENCY STOP" if something is about to be hit. **Take over by hand if the drone gets within
      about 0.5 m of a side wall.**
- [ ] 55. Outcomes:
      - State "Done" with "Arrived at station. Landing on arrival is off: land by hand.": look at the
        drone, then land it with "Takeoff / Land (toggle)".
      - "Take manual control and land": the run stopped early and will not land for you. Fly it back or
        land it by hand. **Look at the drone first: if it is already on the floor, do not press the toggle.**
- [ ] 56. Write the run in the run log (section L), including how far past the arrival point it went.

### H2. Station runs with the landing command on arrival ON

Only after at least one clean run with it off (arrived, no abort, nothing touched).

- [ ] 57. Tick "Send the landing command on arrival (off: you land by hand)".
- [ ] 58. Repeat steps 48 and 50 to 54.
- [ ] 59. On arrival (State "Done"), read the message under the state. It follows what the backend
      reports in `mission.last_landing`:
      - "Arrived at station. The landing command was sent once: check that the drone has landed." Look at
        the drone. If it has landed, done: do **not** press the toggle. If it is still in the air after
        the 4 s, land it by hand.
      - "Arrived at station. The landing command was NOT sent (the descent check could not decide). Land
        by hand." The descent guard had not cleared within 1.0 s after the settle (event detail
        `landing_skipped: "settle_guard_undecided"`). Land by hand.
      - "Arrived at station. The landing command was NOT sent (the safety layer refused it, for example
        because you used the controls just before or the drone link was down). Land by hand." The
        backend refused the toggle, for example because of pilot input in the last 0.4 s (event detail `landing_skipped: "refused_by_mixer"`). Land by hand.
      - "Arrived at station. Check whether the drone has landed; land by hand if not." The backend did not
        report the landing result (an older backend). Look at the drone and land by hand if it is still
        flying.
      In every case look at the drone before pressing anything. The descent guard has a blind window: a
      descent that starts about 0.8 s or later into the 1.2 s settle can still receive the toggle
      (simulator finding). If the drone is already on the floor, do **not** press the toggle.
- [ ] 60. Untick "Send the landing command on arrival (off: you land by hand)" at the end of the session, so the next session starts with it off.

## I. Drift assist (experimental)

Drift assist is experimental and **off by default**. Keep it off for the first runs. Only use it after
**two clean runs without it** on the same day, and only if section E passed (no reversed directions).
It has never been tried on the real drone. Roll trim comes first, drift assist second: in the simulator
(Revision 2 build) the assist could not cancel a large drift, and with the wrong roll direction it made
things worse for 3 to 5 s before switching itself off.

The "Drift assist (experimental)" switch is in the "Station run" panel. If it is missing, or turning it
on shows "Setting not saved", your backend version does not support it: skip this section.

- [ ] 61. Set the roll trim first, using the hover test (section F, steps 37 to 41), until the hover
      test passes.
- [ ] 62. Confirm the roll direction by hand before ever switching drift assist on: hover facing the
      sign and give one short tap of D (roll right). The drone should move right, so the sign should
      slide **left** in the "Camera" picture. **GO:** it does. **NO-GO:** the sign slides right, or the
      drone moves left: do not use drift assist on this drone.
- [ ] 63. Switch on "Drift assist (experimental)".
- [ ] 64. Do a station run exactly as in section H1 (land on arrival off). Watch the "Drift assist roll
      now" value while it flies.
- [ ] 65. If the page says "Drift assist switched itself off for this run", or the drone drifts more than
      without it, switch it off and do not use it again today.
- [ ] 66. After a run, "Suggested roll trim" may appear with an "Apply as trim" button. Treat it as a first
      step, not the answer: in the simulator it suggested about 0.03 too much. Change the roll trim by
      about half of the difference it suggests (with the "Trim" panel), then repeat the hover test
      (section F).

## J. Battery notes

The drone reports a raw battery byte, but what it means has not been verified. MedHop's low-battery
check is therefore **off by default** (`MEDHOP_BATTERY_LOW_RAW=-1`). The page shows the byte and its age,
"No recent reading" when it is older than 3 s, and says the check is off. Do not rely on the byte to warn
you before the drone lands by itself.

- [ ] 67. Write down the byte at every takeoff, and again whenever the drone lands by itself. Over a few
      batteries this shows what the byte means.

| Date | Battery no. | Byte at takeoff | Byte when it landed by itself | Minutes flown on this battery | Notes |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |
| | | | | | |

- [ ] 68. Turning the check on later (only once the log shows a consistent byte at which the drone lands
      by itself): land, motors off, stop `fly-real.sh` with Ctrl-C, run
      `export MEDHOP_BATTERY_LOW_RAW=<value>` and start `fly-real.sh` again. The battery then counts as
      low when the byte is at or below that value, using only readings younger than 3 s. A restart means
      re-checking settings: redo section B, set "Max stick" back to 0.20 (after a restart it starts at
      its default), and check that the landing-on-arrival tick and "Drift assist" show what you expect.
- [ ] 69. After a battery swap: wait for "Drone link: connected" and live video again, then redo
      section B before the next flight. Whether MedHop reconnects by itself after the drone is switched
      off and on has not been tested; if it does not, stop `fly-real.sh` and start it again (and see
      step 68 for what to re-check).

## K. When to stop for the day

Stop, land, and power off if any of these happens:

- any control direction is reversed (section E), or emergency stop did not work (section D);
- the drone touches a wall, the floor or anything else in flight;
- anyone or anything enters the barrier;
- video freezes, or the page shows "Drone link: reconnecting" or "Control link: disconnected,
  reconnecting" during a flight;
- the drone lands by itself, climbs weakly, or feels sluggish (likely a low battery), or a battery is warm,
  swollen or damaged;
- two runs in a row abort for the same reason (fix the cause first);
- a propeller or guard is damaged;
- the light changes (sun moves onto the floor) and the hover test no longer passes;
- you, the helper or the supervising adult are tired or uneasy.

## L. Run log

Print this page, or copy the table. One row per station run, hover test or manual hop.

| Date | Battery no. | Run no. | Start distance (m) | Hover peak excursion (m) | Drift assist on/off | Result (arrived / aborted / manual) | Abort reason | Run time (s) | Distance past arrival point (m) | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | | |
| | | | | | | | | | | |
| | | | | | | | | | | |
| | | | | | | | | | | |
| | | | | | | | | | | |
| | | | | | | | | | | |
| | | | | | | | | | | |
| | | | | | | | | | | |

The backend also writes each run's trace to `data/runs/<run_id>.json` and the events to
`data/events.jsonl`; note the run id in "Notes" if you want to match them up.
