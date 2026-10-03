import { describe, expect, it } from "vitest";
import { validateRunControls } from "./validate.js";

describe("ACP review intent", () => {
  it.each([true, false])("accepts explicit review=%s on ordinary Agent", (review) => {
    expect(validateRunControls({ mode: "agent", review })).toBeNull();
  });
  it("accepts an explicit panel without requiring another flag", () => {
    expect(
      validateRunControls({ mode: "agent", reviewerPanel: [{ harness: "codex" }] }),
    ).toBeNull();
  });
  it("rejects contradictory or meaningless controls", () => {
    expect(
      validateRunControls({ mode: "agent", review: false, reviewerPanel: [{ harness: "codex" }] })
        ?.message,
    ).toContain("review");
    expect(validateRunControls({ mode: "plan", review: false })?.message).toContain("review");
    expect(validateRunControls({ mode: "agent", review: "false" })?.message).toContain("boolean");
  });
});
