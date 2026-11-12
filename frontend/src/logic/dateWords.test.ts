import { describe, expect, it } from "vitest";
import { formatDateWords } from "./dateWords";

describe("formatDateWords", () => {
  it("writes the weekday, day and month", () => {
    expect(formatDateWords("2026-11-12")).toBe("Thursday 12 November");
    expect(formatDateWords("2024-02-29")).toBe("Thursday 29 February");
    expect(formatDateWords("2026-01-01")).toBe("Thursday 1 January");
    expect(formatDateWords("2026-11-15")).toBe("Sunday 15 November");
  });
  it("returns null for malformed or impossible dates", () => {
    expect(formatDateWords("")).toBeNull();
    expect(formatDateWords("2026-13-01")).toBeNull();
    expect(formatDateWords("x")).toBeNull();
    expect(formatDateWords("2026-02-30")).toBeNull();
    expect(formatDateWords("2026-11-12T10:00")).toBeNull();
  });
});
