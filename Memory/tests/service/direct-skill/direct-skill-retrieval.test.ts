import { describe, expect, it } from "vitest";
import type { DirectSkillModule, DirectSkillPackage } from "../../../src/algorithm/direct-skill/types.js";
import {
  packageFromMemory,
  validateSelectedModules
} from "../../../src/service/direct-skill/direct-skill-retrieval-service.js";
import { directSkillExcludedTags } from "../../../src/service/retrieval/retrieval-service.js";

function module(moduleId: string, alternativeGroupKey?: string): DirectSkillModule {
  return {
    moduleId,
    semanticKey: moduleId,
    type: "tactic",
    instruction: `use ${moduleId}`,
    scope: { tasks: [], tools: [], resources: [], operations: [] },
    triggerEvents: ["turn_start"],
    requiredEvidence: [],
    evidenceRefs: ["span_1"],
    authority: "task_evidence",
    evidencePattern: "single_observation",
    strength: "L2",
    alternativeGroupKey,
    sourceModuleIds: [moduleId],
    strengthDecisions: []
  };
}

describe("Direct Skill retrieval boundaries", () => {
  it("keeps package memories out of every generic retrieval mode", () => {
    expect(directSkillExcludedTags("legacy")).toEqual(["direct-skill-package"]);
    expect(directSkillExcludedTags("off")).toEqual(["direct-trace", "direct-skill-package"]);
    expect(directSkillExcludedTags("package_v1")).toEqual(["direct-trace", "direct-skill-package"]);
  });

  it("accepts only tagged and runtime-marked frozen packages whose ID matches the memory", () => {
    const value: DirectSkillPackage = {
      schemaVersion: 1,
      packageId: "dsp_1",
      clusterId: "cluster_1",
      title: "Spreadsheet repair",
      summary: "Repair spreadsheet formulas",
      status: "frozen",
      modules: [module("m1")],
      sourceEpisodeIds: ["episode_1"],
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    const base = {
      id: "dsp_1",
      tags: ["skill", "direct-skill-package"],
      properties: {
        internal_info: {
          runtime_managed: "direct_skill_v1",
          direct_skill_package: value
        }
      }
    };

    expect(packageFromMemory(base)).toEqual(value);
    expect(packageFromMemory({ ...base, tags: ["skill"] })).toBeNull();
    expect(packageFromMemory({
      ...base,
      properties: { internal_info: { ...base.properties.internal_info, runtime_managed: "other" } }
    })).toBeNull();
  });

  it("rejects IDs outside the candidate set and mutually exclusive selections", () => {
    const modules = new Map<string, DirectSkillModule>([
      ["m1", module("m1", "choice")],
      ["m2", module("m2", "choice")],
      ["m3", module("m3")]
    ]);

    expect(validateSelectedModules(["m1", "m3"], ["m1", "m2", "m3"], modules))
      .toEqual(["m1", "m3"]);
    expect(() => validateSelectedModules(["unknown"], ["m1"], modules)).toThrow(/outside/);
    expect(() => validateSelectedModules(["m1", "m2"], ["m1", "m2"], modules)).toThrow(/mutually exclusive/);
  });
});
