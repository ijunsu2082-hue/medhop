import { describe, expect, it } from "vitest";
import type { DoseStatus } from "../api/types";
import { doseTableStatusLine } from "./caregiver";
import { countItems, dayCounts, dayHeadline, isCodeLike, splitStatusLine } from "./caregiverSummary";

const doses = (...statuses: DoseStatus[]) => statuses.map((status) => ({ status }));

describe("dayHeadline", () => {
  it("says when nothing is scheduled", () => {
    expect(dayHeadline([])).toBe("No doses scheduled today");
  });

  it("leads with doses that need attention, singular and plural", () => {
    expect(dayHeadline(doses("needs_attention", "acknowledged", "upcoming"))).toBe("1 of 3 doses needs attention");
    expect(dayHeadline(doses("needs_attention", "needs_attention", "upcoming"))).toBe("2 of 3 doses need attention");
    expect(dayHeadline(doses("needs_attention"))).toBe("Today's dose needs attention");
  });

  it("says when every dose is acknowledged", () => {
    expect(dayHeadline(doses("acknowledged"))).toBe("Today's dose is acknowledged");
    expect(dayHeadline(doses("acknowledged", "acknowledged", "acknowledged"))).toBe("All 3 doses acknowledged");
  });

  it("counts due and arrived doses as due now", () => {
    expect(dayHeadline(doses("acknowledged", "due", "upcoming"))).toBe("1 of 3 doses is due now");
    expect(dayHeadline(doses("due", "arrived", "upcoming"))).toBe("2 of 3 doses are due now");
    expect(dayHeadline(doses("arrived"))).toBe("Today's dose is due now");
  });

  it("falls back to what is still to come", () => {
    expect(dayHeadline(doses("acknowledged", "acknowledged", "upcoming"))).toBe("1 of 3 doses still to come");
    expect(dayHeadline(doses("acknowledged", "upcoming", "upcoming"))).toBe("2 of 3 doses still to come");
    expect(dayHeadline(doses("upcoming", "upcoming", "upcoming"))).toBe("3 of 3 doses still to come");
    expect(dayHeadline(doses("upcoming"))).toBe("Today's dose is still to come");
  });

  it("states only the total for statuses it does not know", () => {
    expect(dayHeadline([{ status: "mystery" }, { status: "mystery" }])).toBe("2 doses scheduled today");
  });
});

describe("dayCounts and countItems", () => {
  it("counts each state", () => {
    expect(dayCounts(doses("needs_attention", "due", "arrived", "acknowledged", "upcoming", "upcoming"))).toEqual({
      total: 6,
      needsAttention: 1,
      dueOrArrived: 2,
      acknowledged: 1,
      upcoming: 2,
    });
  });

  it("keeps zero counts and uses the singular verb for one", () => {
    expect(countItems(dayCounts(doses("needs_attention", "upcoming")))).toEqual([
      { count: 1, words: "needs attention" },
      { count: 0, words: "due now" },
      { count: 0, words: "acknowledged (self-reported)" },
      { count: 1, words: "upcoming" },
    ]);
    expect(countItems(dayCounts(doses("needs_attention", "needs_attention")))[0]).toEqual({
      count: 2,
      words: "need attention",
    });
    expect(countItems(dayCounts([]))[0]).toEqual({ count: 0, words: "need attention" });
  });
});

describe("splitStatusLine", () => {
  const rejoin = (line: string) => {
    const { head, tail } = splitStatusLine(line);
    return tail ? `${head} ${tail}` : head;
  };

  it("splits at the first ' (' and re-joins to the original", () => {
    const cases: [string, string, string][] = [
      [
        "Needs attention (arrived at station 00:13, not acknowledged) (simulator)",
        "Needs attention",
        "(arrived at station 00:13, not acknowledged) (simulator)",
      ],
      ["Acknowledged 08:20 (self-reported)", "Acknowledged 08:20", "(self-reported)"],
      ["Arrived at station 08:12 (simulator)", "Arrived at station 08:12", "(simulator)"],
    ];
    for (const [line, head, tail] of cases) {
      expect(splitStatusLine(line)).toEqual({ head, tail });
      expect(`${splitStatusLine(line).head} ${splitStatusLine(line).tail}`).toBe(line);
    }
  });

  it("gives an empty tail when there is no bracket", () => {
    expect(splitStatusLine("Upcoming")).toEqual({ head: "Upcoming", tail: "" });
    expect(splitStatusLine("Due")).toEqual({ head: "Due", tail: "" });
  });

  it("re-joins every line doseTableStatusLine produces", () => {
    const rows = [
      { status: "upcoming", arrived_at: null, acknowledged_at: null },
      { status: "due", arrived_at: null, acknowledged_at: null },
      { status: "arrived", arrived_at: "08:12", acknowledged_at: null, arrived_mode: "sim" },
      { status: "arrived", arrived_at: "08:12", acknowledged_at: null, arrived_mode: "real" },
      { status: "acknowledged", arrived_at: "08:12", acknowledged_at: "08:20" },
      { status: "acknowledged", arrived_at: null, acknowledged_at: null },
      { status: "needs_attention", arrived_at: "00:13", acknowledged_at: null, arrived_mode: "sim" },
      { status: "needs_attention", arrived_at: null, acknowledged_at: null },
    ] as const;
    for (const r of rows) {
      const line = doseTableStatusLine(r);
      expect(rejoin(line)).toBe(line);
    }
    expect(splitStatusLine(doseTableStatusLine(rows[5]))).toEqual({ head: "Acknowledged", tail: "(self-reported)" });
  });
});

describe("isCodeLike", () => {
  it("is true only for short code-like values", () => {
    expect(isCodeLike("pilot_took_over")).toBe(true);
    expect(isCodeLike("Arrived at station at 13:02 (simulator)")).toBe(false);
    expect(isCodeLike("No run in the recent events.")).toBe(false);
    expect(isCodeLike("Loading.")).toBe(false);
    expect(isCodeLike("")).toBe(false);
  });
});
