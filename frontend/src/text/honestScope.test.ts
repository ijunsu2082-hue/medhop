// Honest scope (SPEC section 1) as a check on the site's own words. It mirrors backend/tests/test_honest_scope.py:
// no claim of a hand-over, waiting for people is never called a safety system, finding the sign is never called AI,
// nothing says medicine was taken, and simulator results are labelled as simulator results.
//
// Two sources are checked: every string the text modules export, and the page and component files, where the
// rest of the visible words are written directly in the markup.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "../testing/cssGuard";
import * as avoidWording from "./avoidWording";
import * as landingWording from "./landingWording";
import { HERO, HOSPITAL, LIMITS, LOOP, RESULTS } from "./landingWording";
import * as panelsWording from "./panelsWording";
import * as pilotWording from "./pilotWording";
import * as shellWording from "./shellWording";
import * as videoWording from "./videoWording";
import * as wording from "./wording";

const MODULES = { avoidWording, landingWording, panelsWording, pilotWording, shellWording, videoWording, wording };

/** Every string reachable from a value: strings, arrays and plain objects. Functions are not called. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => stringsIn(v, out));
  else if (value !== null && typeof value === "object") Object.values(value).forEach((v) => stringsIn(v, out));
  return out;
}

const EXPORTED: { where: string; text: string }[] = Object.entries(MODULES).flatMap(([name, module]) =>
  stringsIn(Object.values(module)).map((text) => ({ where: name, text })),
);

// The emergency stop's motor-cut confirmation is named this way in the status document and the code that reads
// it (SPEC 10.4). None of these is about medicine, and none is shown as a sentence.
const ESTOP_NAMES = [
  "estop_delivered",
  "estopDelivered",
  "active_not_delivered",
  "delivered?: boolean",
  "delivered: last.msg.delivered",
];

const SRC = new URL("../", import.meta.url);
const MARKUP: { where: string; text: string }[] = ["pages/", "components/"].flatMap((dir) =>
  sourceFiles(new URL(dir, SRC), [".tsx"]).flatMap((file) =>
    readFileSync(new URL(dir + file, SRC), "utf8")
      .split(/\r?\n/)
      .map((line, i) => ({
        where: `${dir}${file}:${i + 1}`,
        text: ESTOP_NAMES.reduce((rest, name) => rest.split(name).join(""), line),
      })),
  ),
);

const ALL = [...EXPORTED, ...MARKUP];

const HAND_OVER = /deliver/i;
const STRONG_CLAIM = /interlock|safety[ -]system/i;
const DENIAL = /\b(not|never|no|nothing|cannot)\b/i;
const AI = /\bAI\b|artificial intelligence|machine learning|deep learning|neural/;
const SIGN = /aruco|marker|sign\b/i;
const TAKEN = /\b(taken|took|swallowed)\b/i;
const MEDICINE = /medicine|medication|dose|pill/i;

const offenders = (rows: typeof ALL, bad: (text: string) => boolean) => rows.filter((r) => bad(r.text)).map((r) => `${r.where}: ${r.text.trim()}`);

describe("the scan", () => {
  it("sees the text modules and the pages", () => {
    expect(EXPORTED.length).toBeGreaterThan(150);
    expect(EXPORTED.map((r) => r.text)).toContain(HERO.title);
    const files = new Set(MARKUP.map((r) => r.where.replace(/:\d+$/, "")));
    for (const file of ["pages/LandingPage.tsx", "pages/CarePage.tsx", "pages/CaregiverPage.tsx", "pages/PilotPage.tsx", "components/landing/LandingDemo.tsx"]) {
      expect(files).toContain(file);
    }
  });

  it("keeps the emergency stop exception narrow", () => {
    const strip = (line: string) => ESTOP_NAMES.reduce((rest, name) => rest.split(name).join(""), line);
    expect(HAND_OVER.test(strip("estopDelivered: rawStatus?.pilot.estop_delivered,"))).toBe(false);
    for (const claim of ["Medicine delivered", "delivery", "dose_delivered", "not delivered", "<p>Delivered</p>"]) {
      expect(HAND_OVER.test(strip(claim)), claim).toBe(true);
    }
  });
});

describe("honest scope", () => {
  it("never claims a hand-over", () => {
    expect(offenders(ALL, (t) => HAND_OVER.test(t))).toEqual([]);
  });

  it("mentions a safety system or an interlock only to say it is not one", () => {
    const strong = ALL.filter((r) => STRONG_CLAIM.test(r.text));
    // The scan must see at least the landing page's denial, so this check is never vacuous.
    expect(strong.map((r) => r.text)).toContain(HOSPITAL.note);
    expect(offenders(strong, (t) => !DENIAL.test(t))).toEqual([]);
  });

  it("never calls finding the sign AI", () => {
    expect(offenders(ALL, (t) => AI.test(t) && SIGN.test(t) && !DENIAL.test(t))).toEqual([]);
  });

  it("mentions AI only to deny it", () => {
    expect(offenders(ALL, (t) => AI.test(t) && !DENIAL.test(t))).toEqual([]);
  });

  it("never says medicine was taken", () => {
    expect(offenders(ALL, (t) => TAKEN.test(t) && MEDICINE.test(t) && !DENIAL.test(t))).toEqual([]);
  });
});

describe("the landing page", () => {
  const hospital = stringsIn(HOSPITAL);

  it("says the drone lands at the station, and that pickup is the person's own word", () => {
    expect(LOOP[1]?.body).toMatch(/lands in front of it/);
    expect(LOOP[2]?.body).toMatch(/person's own word/);
    expect(LOOP[2]?.body).toMatch(/not a check that the medicine was taken/);
  });

  it("labels the results as simulator results, and keeps them apart from the real drone", () => {
    expect(RESULTS.simTitle).toMatch(/Python simulator/);
    // The figures are the fuller Python simulator's, which is told exactly where people are: no real detector is.
    expect(RESULTS.simNote).toMatch(/not the demo above/);
    expect(RESULTS.simNote).toMatch(/told exactly where people are/);
    expect(RESULTS.simNote).toMatch(/real detector would make mistakes/);
    // No simulator figure is repeated under the real drone's heading.
    expect(RESULTS.real).not.toMatch(/\d+ of \d+/);
    expect(RESULTS.figures).toHaveLength(3);
    for (const figure of RESULTS.figures) expect(figure.value).toMatch(/^\d+ of \d+$/);
    expect(HOSPITAL.note).toMatch(/simulator only/);
  });

  it("says what waiting for people cannot do", () => {
    expect(HOSPITAL.note).toMatch(/cannot go around/i);
    expect(HOSPITAL.note).toMatch(/simulator only/i);
    expect(HOSPITAL.note).toMatch(/not a safety system/i);
    expect(LIMITS.join(" ")).toMatch(/never flies near people/i);
    expect(LIMITS.join(" ")).toMatch(/Not a medical device/);
  });

  it("makes no claim that it prevents a collision or is safe", () => {
    expect(hospital.filter((t) => /\b(prevents?|guarantees?|safe(ly)?|collision-free)\b/i.test(t))).toEqual([]);
  });

  it("does not claim a clean real flight", () => {
    expect(RESULTS.real).toMatch(/no footage/i);
    expect(RESULTS.real).toMatch(/no clean run from takeoff to landing is on record yet/i);
  });

  it("does not say who wrote the code, and has no section on the hop's internals", () => {
    const all = stringsIn(landingWording).join(" ");
    expect(all).not.toMatch(/coding agents|Who wrote it|pill organiser/);
    expect(Object.keys(landingWording)).not.toEqual(expect.arrayContaining(["HOP_FIGURES"]));
    expect(Object.keys(landingWording)).not.toEqual(expect.arrayContaining(["HOP_POINTS"]));
  });
});
