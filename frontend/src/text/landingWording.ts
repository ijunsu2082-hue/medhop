// Every sentence on the landing page. Kept in one file so the wording rules can be checked by a test
// (text/honestScope.test.ts): "arrived at station", never the d-word; pickup is the person's own report;
// finding the sign is classical computer vision and is never called AI; simulator results are labelled as such.

export const HERO = {
  title: "MedHop reminds an older adult when a dose is due, and flies a toy drone to the medicine station.",
  lead: "A student prototype. The simulator below runs in your browser: nothing to install, and no real drone moves. Choose what is in the corridor and run it.",
  /** The build that talks to the Python backend on this computer shows no in-page simulator. */
  leadLocal:
    "A student prototype. This copy of the site is connected to the MedHop backend on this computer, so there is no simulator on this page: the drone, real or simulated, is flown from the Pilot page.",
  run: "Run the demo",
  runAgain: "Run it again",
  stop: "Stop",
  fly: "Fly it yourself",
} as const;

export const DEMO = {
  cameraLabel: "The simulated drone's camera view of the room and the station sign",
  cameraCaption:
    "The drone's camera, as the control loop sees it: 15 frames a second, about half a second late, like the real one.",
  planCaption: "From above. The dashed circle is where it lands.",
  honest:
    "On the real drone the sign is found in the camera picture with OpenCV. In this browser simulator its position comes from the simulator's own geometry, with noise and dropped frames added. The flight logic that uses it is a TypeScript port of the Python that flies the real drone, checked against it step by step.",
  steps: ["Dose is due", "Count down", "Take off", "Find the sign", "Fly to it", "Line up", "Land"],
  carePanel: "What the person sees",
  caregiverPanel: "What the caregiver sees",
  speedLabel: "Twice as fast",
  /** The dose a demo run is for. A run removes the one an earlier run left in the schedule. */
  doseLabel: "Demo dose",
  careIdle: "Nothing is due. Run the demo and a dose comes due.",
  careLead: "It is time for:",
  pickup: "I picked it up",
  caregiverIdle: "No dose yet.",
  caregiverNote: "Acknowledged is the person's own report. It does not confirm that medicine was taken.",
  linkWait: "Connecting to the simulator.",
} as const;

export interface LoopStep {
  title: string;
  body: string;
}

export const LOOP: readonly LoopStep[] = [
  {
    title: "A dose comes due",
    body: "The Care page is one large, plain screen. It says what is due, can read it aloud, and has one button.",
  },
  {
    title: "The drone hops to the station",
    body: "It takes off, turns until its camera sees a printed sign on the wall, flies to it, lines up and lands in front of it. The Care page then says it arrived at the station.",
  },
  {
    title: "The person says they picked it up",
    body: "One press of “I picked it up”. The caregiver's page shows it as acknowledged. That is the person's own report: nothing here confirms that medicine was taken.",
  },
];

/** The hospital scenario: what the drone does about people and objects in its way. Figures are simulator results. */
export const HOSPITAL = {
  lead: "The same hop could take a dose from a nurses' station to a station by a patient's bed. Corridors have people in them, so the drone now looks for them and waits.",
  points: [
    {
      title: "It sees what is ahead",
      body: "Each camera frame gives a box around every person or object in view. The drone judges how far away each one is from where it meets the floor in the picture.",
    },
    {
      title: "It slows, then waits",
      body: "Something in its lane within 3 m slows it down. Once it is too near for the camera to measure, about 2.5 m, the drone stops and holds its position. When the lane has been clear for a second, it carries on to the station.",
    },
    {
      title: "It lands if the way stays blocked",
      body: "After 25 seconds of waiting it lands where it is and reports that the path is blocked, so someone can clear the corridor and send it again.",
    },
    {
      title: "It will not take off into an obstacle",
      body: "If something is already standing in its lane, the run is refused before the motors start.",
    },
  ],
  figuresNote: "In the simulator, 20 runs of each kind:",
  figures: [
    { value: "20 of 20", label: "reached the station after waiting for a person to cross" },
    { value: "20 of 20", label: "landed and reported when the corridor stayed blocked" },
    { value: "1.1 m", label: "the closest the drone came to anyone" },
  ],
  cannotTitle: "What it cannot do",
  cannot: [
    "It cannot go around an obstacle. Its one small forward camera cannot judge distance to anything nearer than about 2.5 m, so stepping around a trolley was built, tested and removed: it reached the station in 1 of 20 simulated runs.",
    "On the real drone this is switched off unless the pilot turns it on. Only people can be detected there, and only with an optional detector running. With it off, a person in view stops the run.",
    "All of it is tested in the simulator only. It is not a safety system, and the real drone has never been flown near people and must not be.",
  ],
} as const;

export interface Figure {
  value: string;
  label: string;
}

export const HOP_FIGURES: readonly Figure[] = [
  { value: "0.45 m", label: "where it lands, measured from the sign" },
  { value: "4 cm", label: "how close to the sign's centre line it must be" },
  { value: "1 s", label: "how long it must hold that before landing" },
  { value: "45 s", label: "limit for the whole run, after which it stops" },
];

export const HOP_POINTS: readonly string[] = [
  "The sign is an ArUco marker, 180 mm square, printed on a sheet of A4. Finding it is classical computer vision, not machine learning.",
  "The pilot always wins. Any touch of the controls hands the drone back, and the space bar is an emergency stop that cuts the motors.",
  "The camera picture arrives about half a second after each command, so the steering allows for turns it has ordered but cannot see yet.",
  "If the sign drops out of view for a moment, the drone coasts on its last course for up to half a second instead of stopping.",
];

export const RESULTS = {
  simTitle: "In the simulator",
  simNote:
    "Twenty runs of each kind in the Python simulator, which draws the camera picture and finds the sign in it with the same code as the real drone. Every run had a sideways drift of 8 cm a second.",
  sim: [
    "Empty corridor, starting 2.5 m from the sign: 20 of 20 landed in front of it, 0.35 to 0.50 m away and within 4 cm of its centre line. A run took 27 to 37 seconds.",
    "A person walks across, starting 4.2 m away: 20 of 20 waited for them and then reached the station.",
    "A person, or three people, stay in the way: 40 of 40 waited 25 seconds, then landed where they were and reported the path blocked.",
  ],
  realTitle: "On the real drone",
  real: [
    "The drone has flown station runs for real. There is no footage of them.",
    "In one run the drone hovered and did not land. In another it found the sign from about 4 m away and then stalled on the approach, because the sign was missing from about 45% of the camera frames.",
    "Both faults were fixed in the flight logic, and the fixes were tested in the simulator. The project's notes do not yet record a real run that went cleanly from takeoff to landing.",
  ],
} as const;

export const LIMITS: readonly string[] = [
  "It is a prototype built for student hackathons, using demo data only.",
  "It is not a medical device, and it never confirms that medicine was taken.",
  "The drone never carries real medicine and is never flown near people. Every real flight is supervised, with a pilot at the controls.",
  "Waiting for people and obstacles is tested in the simulator only. It is not a safety system.",
  "For most people a pill organiser or a phone reminder would be simpler, cheaper and more reliable. Whether the drone leg is worth having is unproven.",
];

export const BUILD: readonly { term: string; detail: string }[] = [
  {
    term: "Drone",
    detail:
      "A toy camera drone sold as the AXNEN i1. No GPS and no official programming interface; MedHop talks to it through the open-source turbodrone project.",
  },
  {
    term: "Camera",
    detail: "640 by 360 pixels at about 15 frames a second, arriving 0.4 to 0.5 seconds after each command.",
  },
  {
    term: "Software",
    detail:
      "A Python backend (FastAPI, OpenCV) flies the real drone. This site is React and TypeScript, and carries its own copy of the flight logic for the browser simulator.",
  },
  {
    term: "Who wrote it",
    detail:
      "Almost all of the code was written by AI coding agents. The idea, the requirements, the hardware, the flying and the decisions are the author's.",
  },
];

export const SECTIONS = {
  how: "How it works",
  hospital: "In a hospital corridor",
  hop: "The hop, in detail",
  results: "Results so far",
  limits: "What it is not",
  build: "Hardware and build",
} as const;
