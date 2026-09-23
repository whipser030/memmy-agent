import { describe, expect, it } from "vitest";
import { ModuleExtractor } from "../../../src/algorithm/direct-skill/module-extractor.js";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import type { LlmClient } from "../../../src/model/types.js";

describe("ModuleExtractor", () => {
  it("returns multiple evidenced candidates from one model call", async () => {
    let calls = 0;
    const llm = fakeLlm(async (messages) => {
      calls += 1;
      expect(messages[0]!.content).toContain("failure evidence cannot support tactic or fast_path");
      const source = JSON.parse(messages[1]!.content) as Record<string, unknown>;
      expect(source.toolSteps).toEqual([{
        evidenceRef: "turn-1:tool:0",
        call: { id: "call-1", name: "save", arguments: { preserve: "keep formulas" } },
        result: { status: "saved" }
      }]);
      expect(source.evaluation).toEqual({ rTask: 1, detail: { source: "official" } });
      return {
        decision: "accept",
        modules: [
          {
            material: {
              subgoal: "Save workbook",
              outcome: "success",
              observation: "The task says keep formulas",
              proposedAction: "Preserve formulas while saving",
              scopeClues: ["xlsx"],
              evidenceRefs: ["sourceId:tool:0"],
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
              evidenceRefs: ["sourceId:tool:0"],
              authority: "task_hard_constraint",
              evidencePattern: "explicit_statement"
            }
          },
          {
            material: {
              subgoal: "Verify workbook",
              outcome: "success",
              observation: "The saved workbook was reopened successfully",
              proposedAction: "Reopen the workbook before submission",
              scopeClues: ["xlsx"],
              evidenceRefs: ["turn-1:tool:0"],
              authorityEvidence: null
            },
            candidateModule: {
              semanticKey: "reopen_saved_workbook",
              type: "verification",
              instruction: "Reopen the saved workbook before submission.",
              scope: { tasks: ["spreadsheet"], tools: ["python"], resources: ["xlsx"], operations: ["verify"] },
              triggerEvents: ["before_submit"],
              completionRule: "The saved workbook opens successfully.",
              requiredEvidence: ["successful reopen result"],
              recovery: "Repair the workbook and save it again.",
              evidenceRefs: ["turn-1:tool:0"],
              authority: "task_evidence",
              evidencePattern: "validator_confirmed"
            }
          }
        ]
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
      toolSteps: [{
        evidenceRef: "turn-1:tool:0",
        call: { id: "call-1", name: "save", arguments: { preserve: "keep formulas" } },
        result: { status: "saved" }
      }],
      evaluation: { rTask: 1, detail: { source: "official" } }
    });
    expect(calls).toBe(1);
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.modules).toHaveLength(2);
      expect(result.modules[0]!.material.rawTurnId).toBe("turn-1");
      expect(result.modules[0]!.candidateModule.material).toBe(result.modules[0]!.material);
      expect(result.modules.map((item) => item.candidateModule.type)).toEqual(["invariant", "verification"]);
      expect(result.modules[0]!.material.materialId).not.toBe(result.modules[1]!.material.materialId);
      expect(result.modules[0]!.candidateModule.evidenceRefs).toEqual(["turn-1:tool:0"]);
    }
  });

  it("rejects a hard constraint whose authority text is not present in the source", async () => {
    const llm = fakeLlm(async () => ({
      decision: "accept",
      modules: [{
        material: {
          subgoal: "save",
          outcome: "success",
          observation: "saved",
          proposedAction: "save",
          scopeClues: [],
          evidenceRefs: ["turn-1"],
          authorityEvidence: { statement: "invented hard requirement", evidenceRef: "turn-1" }
        },
        candidateModule: {
          semanticKey: "invented_constraint",
          type: "invariant",
          instruction: "Follow the invented hard requirement.",
          scope: { tasks: [], tools: [], resources: [], operations: [] },
          triggerEvents: ["turn_start"],
          completionRule: "Requirement followed.",
          requiredEvidence: ["proof"],
          recovery: "Stop.",
          evidenceRefs: ["turn-1"],
          authority: "task_hard_constraint",
          evidencePattern: "explicit_statement"
        }
      }]
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
      toolSteps: [],
      evaluation: { rTask: 1, detail: {} }
    })).rejects.toThrow(
      "hard constraint authorityEvidence is invalid, semanticKey=invented_constraint, " +
      "reason=direct-skill authority statement is not present in source evidence"
    );
  });

  it("repairs an invalid module without discarding valid modules from the same response", async () => {
    const operations: string[] = [];
    const validModule = {
      material: {
        subgoal: "save",
        outcome: "success",
        observation: "saved",
        proposedAction: "reopen the saved workbook",
        scopeClues: ["xlsx"],
        evidenceRefs: ["turn-1"],
        authorityEvidence: null
      },
      candidateModule: {
        semanticKey: "reopen_workbook",
        type: "verification",
        instruction: "Reopen the saved workbook.",
        scope: { tasks: ["spreadsheet"], tools: [], resources: ["xlsx"], operations: ["verify"] },
        triggerEvents: ["before_submit"],
        completionRule: "Workbook opens.",
        requiredEvidence: ["successful reopen"],
        recovery: "Repair and save again.",
        evidenceRefs: ["turn-1"],
        authority: "task_evidence",
        evidencePattern: "single_observation"
      }
    };
    const invalidHardModule = {
      material: {
        subgoal: "save",
        outcome: "success",
        observation: "formula preservation is required",
        proposedAction: "preserve formulas",
        scopeClues: ["xlsx"],
        evidenceRefs: ["turn-1"],
        authorityEvidence: null
      },
      candidateModule: {
        semanticKey: "preserve_formulas",
        type: "invariant",
        instruction: "Do not overwrite formulas.",
        scope: { tasks: ["spreadsheet"], tools: [], resources: ["xlsx"], operations: ["write"] },
        triggerEvents: ["turn_start"],
        completionRule: "Formulas remain formulas.",
        requiredEvidence: ["formula cells"],
        recovery: "Restore formulas from the source.",
        evidenceRefs: ["turn-1"],
        authority: "task_hard_constraint",
        evidencePattern: "explicit_statement"
      }
    };
    const llm = fakeLlm(async (_messages, options) => {
      operations.push(options.operation);
      if (options.operation === "direct_skill.module.repair") {
        return {
          modules: [{
            ...invalidHardModule,
            material: {
              ...invalidHardModule.material,
              authorityEvidence: { statement: "Do not overwrite formulas", evidenceRef: "turn-1" }
            }
          }]
        };
      }
      return { decision: "accept", modules: [validModule, invalidHardModule] };
    });

    const result = await new ModuleExtractor(llm).extractFromTurn({
      sourceType: "turn",
      sourceId: "turn-1",
      episodeId: "episode-1",
      outcome: "success",
      userRequest: "Do not overwrite formulas while saving.",
      assistantFinalAnswer: "Saved.",
      subgoal: "save",
      summary: "saved",
      toolSteps: [],
      evaluation: { rTask: 1, detail: {} }
    });

    expect(operations).toEqual(["direct_skill.module.extract_turn", "direct_skill.module.repair"]);
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") {
      expect(result.modules.map((item) => item.candidateModule.semanticKey))
        .toEqual(["reopen_workbook", "preserve_formulas"]);
    }
  });

  it("ignores unused invalid authority evidence on a non-hard module", async () => {
    const llm = fakeLlm(async () => ({
      decision: "accept",
      modules: [{
        material: {
          subgoal: "save",
          outcome: "success",
          observation: "saved",
          proposedAction: "save",
          scopeClues: [],
          evidenceRefs: ["turn-1"],
          authorityEvidence: { statement: "paraphrased advice", evidenceRef: "turn-1" }
        },
        candidateModule: {
          semanticKey: "save_workbook",
          type: "tactic",
          instruction: "Save the workbook after editing.",
          scope: { tasks: ["spreadsheet"], tools: [], resources: ["xlsx"], operations: ["save"] },
          triggerEvents: ["turn_start"],
          completionRule: "Workbook exists.",
          requiredEvidence: [],
          recovery: "Save again.",
          evidenceRefs: ["turn-1"],
          authority: "task_evidence",
          evidencePattern: "single_observation"
        }
      }]
    }));
    const result = await new ModuleExtractor(llm).extractFromTurn({
      sourceType: "turn",
      sourceId: "turn-1",
      episodeId: "episode-1",
      outcome: "success",
      userRequest: "save",
      assistantFinalAnswer: "saved",
      subgoal: "save",
      summary: "saved",
      toolSteps: [],
      evaluation: { rTask: 1, detail: {} }
    });
    expect(result.decision).toBe("accept");
    if (result.decision === "accept") expect(result.modules[0]!.material.authorityEvidence).toBeUndefined();
  });
});

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
