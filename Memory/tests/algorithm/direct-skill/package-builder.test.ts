import { describe, expect, it } from "vitest";
import { PackageBuilder } from "../../../src/algorithm/direct-skill/package-builder.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import type { CandidateModuleRecord } from "../../../src/algorithm/direct-skill/types.js";
import type { LlmClient } from "../../../src/model/types.js";

describe("PackageBuilder", () => {
  it("reports the normal no-candidate failure when filtering removes every candidate", async () => {
    const llm = fakeLlm(async () => ({}));
    await expect(new PackageBuilder(llm).build({
      packageId: "package-empty",
      clusterId: "cluster-empty",
      candidates: [],
      sourceEpisodeIds: ["e1"],
      createdAt: "2026-01-01T00:00:00.000Z"
    })).rejects.toThrow("has no candidate modules");
  });

  it("merges compatible modules and keeps alternatives mutually exclusive", async () => {
    const llm = fakeLlm(async (messages, options) => {
      const payload = JSON.parse(messages[1]!.content) as Record<string, unknown>;
      if (options.operation === "direct_skill.strength.review") {
        const candidates = payload.candidates as Array<{ candidate: { moduleId: string } }>;
        return { votes: candidates.map(({ candidate }) => ({
          moduleId: candidate.moduleId,
          constraintMode: "advisory",
          guideSpecificity: "actionable",
          authority: "task_evidence",
          observability: "trace_observable",
          strength: "L2",
          reason: "actionable advice"
        })) };
      }
      return {
        title: "Workbook repair",
        summary: "Repair and verify spreadsheet writes.",
        mergeGroups: [{ groupId: "verify", candidateModuleIds: ["m1", "m2"] }],
        alternativeGroups: [{ groupKey: "repair_choice", memberRefs: ["verify", "m3"] }]
      };
    });
    const result = await new PackageBuilder(llm).build({
      packageId: "package-1",
      clusterId: "cluster-1",
      candidates: [
        candidate("m1", "verify_save", "Verify the saved workbook."),
        candidate("m2", "verify_save", "Reopen the workbook and inspect its formulas."),
        candidate("m3", "repair_save")
      ],
      sourceEpisodeIds: ["e1", "e2"],
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    expect(result.status).toBe("frozen");
    expect(result.modules).toHaveLength(2);
    expect(result.modules[0]!.sourceModuleIds).toEqual(["m1", "m2"]);
    expect(result.modules.every((module) => module.alternativeGroupKey === "repair_choice")).toBe(true);
    expect(result.modules[0]!.strengthDecisions).toHaveLength(2);
    expect(result.modules[0]!.instruction).toBe([
      "1. Verify the saved workbook.",
      "2. Reopen the workbook and inspect its formulas."
    ].join("\n"));
  });
});

function candidate(
  moduleId: string,
  semanticKey: string,
  instruction = "Verify the saved workbook."
): CandidateModuleRecord {
  return {
    moduleId,
    semanticKey,
    type: "verification",
    instruction,
    scope: { tasks: ["spreadsheet"], tools: ["python"], resources: ["xlsx"], operations: ["verify"] },
    triggerEvents: ["before_submit"],
    requiredEvidence: ["saved workbook"],
    evidenceRefs: [`turn-${moduleId}`],
    authority: "task_evidence",
    evidencePattern: "validator_confirmed",
    material: {
      materialId: `mat-${moduleId}`,
      rawTurnId: `turn-${moduleId}`,
      episodeId: "episode-1",
      subgoal: "verify",
      outcome: "success",
      observation: "verified",
      proposedAction: "verify",
      scopeClues: ["xlsx"],
      evidenceRefs: [`turn-${moduleId}`]
    }
  };
}

function fakeLlm(
  completeJson: (
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    options: { operation: string }
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
