import { describe, expect, it } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import { StrengthVoter, aggregateVotes } from "../../../src/algorithm/direct-skill/strength-voter.js";
import type {
  CandidateModuleRecord,
  SkillStrength,
  StrengthVote
} from "../../../src/algorithm/direct-skill/types.js";
import type { LlmClient } from "../../../src/model/types.js";

describe("StrengthVoter", () => {
  it("reviews the full batch three times and aligns shuffled responses by moduleId", async () => {
    const seenOrders: string[][] = [];
    let call = 0;
    const strengths: SkillStrength[][] = [
      ["L1", "L2"],
      ["L2", "L2"],
      ["L3", "L4"]
    ];
    const llm = fakeLlm(async (messages) => {
      const payload = JSON.parse(messages[1]!.content) as {
        candidates: Array<{ candidate: { moduleId: string } }>;
      };
      const ids = payload.candidates.map((item) => item.candidate.moduleId);
      seenOrders.push(ids);
      const current = call++;
      return {
        votes: ids.map((moduleId) => vote(moduleId, strengths[current]![moduleId === "m1" ? 0 : 1]!))
      };
    });
    const result = await new StrengthVoter(llm).grade("package-a", [candidate("m1"), candidate("m2")]);
    expect(seenOrders).toHaveLength(3);
    expect(seenOrders.every((ids) => ids.length === 2 && ids.includes("m1") && ids.includes("m2"))).toBe(true);
    expect(result.map((item) => item.strengthDecision.finalStrength)).toEqual(["L2", "L2"]);
    expect(result[0]!.strengthDecision.aggregation).toBe("median");
    expect(result[1]!.strengthDecision.aggregation).toBe("majority");
  });

  it("uses the middle strength when all three votes differ", () => {
    const decision = aggregateVotes("m1", [vote("m1", "L4"), vote("m1", "L1"), vote("m1", "L3")]);
    expect(decision.finalStrength).toBe("L3");
    expect(decision.aggregation).toBe("median");
  });
});

function candidate(moduleId: string): CandidateModuleRecord {
  return {
    moduleId,
    semanticKey: `key_${moduleId}`,
    type: "verification",
    instruction: "Verify the workbook.",
    scope: { tasks: ["spreadsheet"], tools: ["python"], resources: [], operations: [] },
    triggerEvents: ["before_submit"],
    requiredEvidence: ["saved workbook"],
    evidenceRefs: ["turn-1"],
    authority: "task_evidence",
    evidencePattern: "validator_confirmed",
    material: {
      materialId: `mat_${moduleId}`,
      rawTurnId: "turn-1",
      episodeId: "episode-1",
      subgoal: "verify",
      outcome: "success",
      observation: "verification succeeded",
      proposedAction: "verify before submit",
      scopeClues: ["spreadsheet"],
      evidenceRefs: ["turn-1"]
    }
  };
}

function vote(moduleId: string, strength: SkillStrength): StrengthVote {
  return {
    moduleId,
    constraintMode: strength === "L1" ? "reference" : "advisory",
    guideSpecificity: "actionable",
    authority: "task_evidence",
    observability: "trace_observable",
    strength,
    reason: "test"
  };
}

function fakeLlm(
  completeJson: (messages: Array<{ role: "system" | "user" | "assistant"; content: string }>) => Promise<Record<string, unknown>>
): LlmClient {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.evolution, provider: "host", endpoint: "http://test", model: "test" },
    isConfigured: () => true,
    complete: async () => "{}",
    completeJson: completeJson as LlmClient["completeJson"],
    status: () => ({ provider: "host", model: "test", configured: true, remote: false })
  };
}
