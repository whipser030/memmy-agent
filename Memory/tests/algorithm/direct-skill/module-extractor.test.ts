import { describe, expect, it } from "vitest";
import { ModuleExtractor } from "../../../src/algorithm/direct-skill/module-extractor.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import type { LlmClient } from "../../../src/model/types.js";

describe("ModuleExtractor", () => {
  it("returns material and one candidate from one model call", async () => {
    let calls = 0;
    const llm = fakeLlm(async (messages) => {
      calls += 1;
      expect(messages[0]!.content).toContain("failure evidence cannot support tactic or fast_path");
      return {
        decision: "accept",
        material: {
          subgoal: "Save workbook",
          outcome: "success",
          observation: "The task says keep formulas",
          proposedAction: "Preserve formulas while saving",
          scopeClues: ["xlsx"],
          evidenceRefs: ["turn-1"],
          authorityEvidence: { statement: "keep formulas", evidenceRef: "turn-1" }
        },
        candidateModule: {
          semanticKey: "preserve_formulas",
          type: "invariant",
          instruction: "Keep formulas intact while writing the workbook.",
          scope: { tasks: ["spreadsheet"], tools: ["python"], resources: ["xlsx"], operations: ["write"] },
          triggerEvents: ["turn_start", "before_submit"],
          completionRule: "The saved cells retain formulas.",
          requiredEvidence: ["saved workbook"],
          recovery: "Reload the source and repeat without replacing formulas.",
          evidenceRefs: ["turn-1"],
          authority: "task_hard_constraint",
          evidencePattern: "explicit_statement"
        }
      };
    });
    const result = await new ModuleExtractor(llm).extractFromTurn({
      sourceType: "turn",
      sourceId: "turn-1",
      episodeId: "episode-1",
      outcome: "success",
      userRequest: "Update totals and keep formulas",
      assistantFinalAnswer: "Saved.",
      subgoal: "Save workbook",
      summary: "Kept formulas",
      toolCalls: []
    });
    expect(calls).toBe(1);
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.material.rawTurnId).toBe("turn-1");
      expect(result.candidateModule.material).toBe(result.material);
      expect(result.candidateModule.type).toBe("invariant");
    }
  });

  it("rejects authority text that is not present in the source", async () => {
    const llm = fakeLlm(async () => ({
      decision: "accept",
      material: {
        subgoal: "save",
        outcome: "success",
        observation: "saved",
        proposedAction: "save",
        scopeClues: [],
        evidenceRefs: ["turn-1"],
        authorityEvidence: { statement: "invented hard requirement", evidenceRef: "turn-1" }
      },
      candidateModule: {}
    }));
    await expect(new ModuleExtractor(llm).extractFromTurn({
      sourceType: "turn",
      sourceId: "turn-1",
      episodeId: "episode-1",
      outcome: "success",
      userRequest: "save",
      assistantFinalAnswer: "saved",
      subgoal: "save",
      summary: "saved",
      toolCalls: []
    })).rejects.toThrow("authority statement is not present");
  });
});

function fakeLlm(
  completeJson: (
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  ) => Promise<Record<string, unknown>>
): LlmClient {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.evolution, provider: "host", endpoint: "http://test", model: "test" },
    isConfigured: () => true,
    complete: async () => "{}",
    completeJson: completeJson as LlmClient["completeJson"],
    status: () => ({ provider: "host", model: "test", configured: true, remote: false })
  };
}
