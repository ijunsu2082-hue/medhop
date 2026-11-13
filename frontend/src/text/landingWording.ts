// Every sentence on the landing page. Kept in one file so the wording rules can be checked by a test
// (text/honestScope.test.ts): "arrived at station", never the d-word; pickup is the person's own report;
// finding the sign is classical computer vision and is never called AI; simulator results are labelled as such.

export const HERO = {
  title: "MedHop reminds an older adult when a dose is due, and flies a toy drone to the medicine station.",
  lead: "A student prototype. Pick what is in the corridor, press Run, and watch it fly in your browser. No real drone moves.",
  /** The build that talks to the Python backend on this computer shows no in-page simulator. */
  leadLocal:
    "A student prototype. This copy of the site talks to the MedHop backend on this computer, so there is no simulator on this page: the drone, real or simulated, is flown from the Pilot page.",
  run: "Run the demo",
  runAgain: "Run it again",
  stop: "Stop",
  fly: "Fly it yourself",
} as const;

export const DEMO = {
  cameraLabel: "The simulated drone's camera view of the room and the station sign",
  cameraCaption: "The drone's camera view, about half a second behind, like the real one.",
  planCaption: "From above. It lands on the dashed circle.",
  honest:
    "This is a simulator. It runs the same flight logic as the real drone, but it works out where the sign is instead of finding it in a camera picture.",
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
  recovering: "The simulated drone was still in the air. Landing it before the next run.",
  settling: "The drone has just landed. Ready again in a few seconds.",
} as const;

export interface LoopStep {
  title: string;
  body: string;
}

export const LOOP: readonly LoopStep[] = [
  { title: "A dose comes due", body: "The Care page shows what to take and can read it out loud." },
  { title: "The drone flies to the station", body: "It takes off, finds a printed sign on the wall and lands in front of it." },
  {
    title: "The person taps “I picked it up”",
    body: "Their caregiver sees it. That is the person's own word, not a check that the medicine was taken.",
  },
];

/** The hospital scenario: what the drone does about people and objects in its way. Simulator only. */
export const HOSPITAL = {
  lead: "A nurse could send a dose from the nurses' station to a patient's bedside. Corridors have people in them, so the drone waits for them.",
  points: [
    "Slows down when someone is within 3 m.",
    "Stops and waits when they get close, then carries on once the way is clear.",
    "Lands and reports a blocked path after waiting 25 seconds.",
    "Will not take off if something is already in the way.",
  ],
  note: "So far this runs in the simulator only. The drone can wait, but it cannot go around things, and it is not a safety system.",
} as const;

export interface Figure {
  value: string;
  label: string;
}

export const RESULTS = {
  simTitle: "In the simulator",
  simNote: "20 runs of each.",
  figures: [
    { value: "20 of 20", label: "landed in front of the sign in an empty corridor, in 27 to 37 seconds" },
    { value: "20 of 20", label: "waited for a person to walk across, then reached the station" },
    { value: "40 of 40", label: "landed and reported it when people stayed in the way" },
  ] as readonly Figure[],
  closest: "The closest it came to a person was 1.1 m.",
  realTitle: "On the real drone",
  real: "It has flown, but no clean run from takeoff to landing is on record yet. One run hovered and never landed. Another lost sight of the sign on the way in. Both problems are fixed in the code, and the fixes are tested in the simulator. There is no footage.",
} as const;

export const LIMITS: readonly string[] = [
  "A student hackathon prototype. All the data is made up for the demo.",
  "Not a medical device. It cannot tell whether medicine was taken.",
  "The drone never carries real medicine and never flies near people. A pilot is always at the controls, and the space bar is the emergency stop.",
];

export const BUILD: readonly { term: string; detail: string }[] = [
  { term: "Drone", detail: "AXNEN i1, a toy camera drone with no GPS." },
  { term: "Camera", detail: "640 × 360 pixels, about 15 frames a second, half a second behind." },
  { term: "Sign", detail: "A printed ArUco marker, 18 cm wide. Finding it is ordinary computer vision, not AI." },
  { term: "Software", detail: "Python flies the real drone. This site is React and TypeScript." },
];

export const SIGN_CAPTION = "The station sign, as printed.";

export const SECTIONS = {
  how: "How it works",
  hospital: "In a hospital",
  results: "Results",
  limits: "Limits",
  build: "Hardware",
} as const;
