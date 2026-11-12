import { describe, expect, it } from "vitest";
import { STICKPAD_LOCKED_REASON } from "./panelsWording";

describe("panels wording", () => {
  it("pins the on-screen sticks' locked reason", () => {
    expect(STICKPAD_LOCKED_REASON).toBe(
      "Locked: the control link is not connected, so these buttons send no stick input.",
    );
  });

  it("states the reason in full, with no ellipsis and no hype", () => {
    expect(STICKPAD_LOCKED_REASON).not.toMatch(/\.\.\.|…/);
    expect(STICKPAD_LOCKED_REASON.toLowerCase()).not.toMatch(/\bai\b|delivered|smart|seamless/);
  });
});
