import { describe, expect, it } from "vitest";
import { renderDirectSkillSop } from "../../src/direct-skill-runtime/renderer.js";

describe("renderDirectSkillSop", () => {
  it("shows strength and the L3/L4 execution contract", () => {
    const rendered = renderDirectSkillSop({ packageId: "pkg", modules: [] }, [{
      moduleId: "guard",
      strength: "L4",
      instruction: "Do not overwrite formulas.",
      triggerEvents: ["before_submit"],
      completionRule: "All formula cells remain formulas.",
      requiredEvidence: ["formula scan"],
      recovery: "Restore formulas from the source workbook.",
    }], { eventTypes: ["before_submit"], occurredAt: "now" });
    expect(rendered).toContain("[L4] Do not overwrite formulas.");
    expect(rendered).toContain("L1 is optional reference");
    expect(rendered).toContain("Completion: All formula cells remain formulas.");
    expect(rendered).toContain("Evidence: formula scan");
    expect(rendered).toContain("Recovery: Restore formulas from the source workbook.");
  });
});
