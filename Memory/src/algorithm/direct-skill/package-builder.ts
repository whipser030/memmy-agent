import type { LlmClient } from "../../model/types.js";
import { newId, stableHash, stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { StrengthVoter } from "./strength-voter.js";
import type {
  CandidateModuleRecord,
  DirectSkillModule,
  DirectSkillPackage,
  GradedCandidateModule
} from "./types.js";

const PACKAGE_CONSOLIDATION_PROMPT = `Organize the final modules in one skill package.

The modules have already been merged. Do not merge, delete, invent, or rewrite modules.
alternativeGroups identify solutions to a similar problem that cannot be used together. Do not merge alternatives.
Every alternative member must reference a supplied final module ID.
Omit alternative groups that contain fewer than two distinct members.

Return JSON only:
{
  "title": "...", "summary": "...",
  "alternativeGroups": [{ "groupKey": "...", "memberRefs": ["..."] }]
}`;

interface AlternativeGroup {
  groupKey: string;
  memberRefs: string[];
}

export class PackageBuilder {
  private readonly voter: StrengthVoter;

  constructor(private readonly llm: LlmClient, voter?: StrengthVoter) {
    this.voter = voter ?? new StrengthVoter(llm);
  }

  async build(input: {
    packageId?: string;
    clusterId: string;
    candidates: CandidateModuleRecord[];
    sourceEpisodeIds: string[];
    createdAt: string;
  }): Promise<DirectSkillPackage> {
    if (input.candidates.length === 0) throw new Error(`direct-skill cluster ${input.clusterId} has no candidate modules`);
    const packageId = input.packageId ?? newId("dsp");
    const graded = await this.voter.grade(packageId, input.candidates);
    const modules = mergeCompatibleCandidates(graded);
    const organization = await this.consolidate(modules);
    applyAlternativeGroups(modules, organization.alternativeGroups);
    return {
      schemaVersion: 1,
      packageId,
      clusterId: input.clusterId,
      title: organization.title,
      summary: organization.summary,
      status: "frozen",
      modules,
      sourceEpisodeIds: unique(input.sourceEpisodeIds),
      createdAt: input.createdAt
    };
  }

  private async consolidate(modules: DirectSkillModule[]): Promise<{
    title: string;
    summary: string;
    alternativeGroups: AlternativeGroup[];
  }> {
    const result = await this.llm.completeJson<Record<string, unknown>>([
      { role: "system", content: PACKAGE_CONSOLIDATION_PROMPT },
      {
        role: "user",
        content: stableStringify({
          modules: modules.map((module) => ({
            moduleId: module.moduleId,
            semanticKey: module.semanticKey,
            type: module.type,
            instruction: module.instruction
          }))
        })
      }
    ], {
      operation: "direct_skill.package.consolidate",
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 8192
    });
    return {
      title: requiredText(result.title, "title"),
      summary: requiredText(result.summary, "summary"),
      alternativeGroups: parseAlternativeGroups(result.alternativeGroups)
    };
  }
}

function mergeCompatibleCandidates(candidates: GradedCandidateModule[]): DirectSkillModule[] {
  const groups = new Map<string, GradedCandidateModule[]>();
  for (const candidate of candidates) {
    const signature = mergeSignature(candidate);
    groups.set(signature, [...(groups.get(signature) ?? []), candidate]);
  }
  return [...groups.values()].map((members) => {
    const sorted = [...members].sort((left, right) => left.moduleId.localeCompare(right.moduleId));
    const first = sorted[0]!;
    return {
      ...moduleFields(first),
      instruction: mergeInstructions(sorted),
      moduleId: sorted.length === 1
        ? first.moduleId
        : `dsmg_${stableHash(sorted.map((member) => member.moduleId).join(":")).slice(0, 20)}`,
      strength: first.strengthDecision.finalStrength,
      evidenceRefs: unique(sorted.flatMap((member) => member.evidenceRefs)),
      sourceModuleIds: sorted.map((member) => member.moduleId),
      strengthDecisions: sorted.map((member) => member.strengthDecision)
    };
  });
}

function applyAlternativeGroups(modules: DirectSkillModule[], alternativeGroups: AlternativeGroup[]): void {
  const byId = new Map(modules.map((module) => [module.moduleId, module]));
  const assignedAlternative = new Set<string>();
  for (const group of alternativeGroups) {
    if (group.memberRefs.length < 2) continue;
    const members = group.memberRefs.map((ref) => {
      const module = byId.get(ref);
      if (!module) throw new Error(`direct-skill alternative group ${group.groupKey} references unknown module: ${ref}`);
      return module;
    });
    const duplicate = members.find((module) => assignedAlternative.has(module.moduleId));
    if (duplicate) {
      throw new Error(`direct-skill module belongs to multiple alternative groups: ${duplicate.moduleId}`);
    }
    for (const module of members) {
      module.alternativeGroupKey = group.groupKey;
      assignedAlternative.add(module.moduleId);
    }
  }
}

function mergeSignature(candidate: GradedCandidateModule): string {
  return stableStringify({
    semanticKey: candidate.semanticKey,
    type: candidate.type,
    strength: candidate.strengthDecision.finalStrength,
    scope: {
      tasks: sortedUnique(candidate.scope.tasks),
      tools: sortedUnique(candidate.scope.tools),
      resources: sortedUnique(candidate.scope.resources),
      operations: sortedUnique(candidate.scope.operations)
    },
    triggerEvents: sortedUnique(candidate.triggerEvents),
    completionRule: candidate.completionRule ?? null,
    requiredEvidence: sortedUnique(candidate.requiredEvidence),
    recovery: candidate.recovery ?? null,
    authority: candidate.authority,
    evidencePattern: candidate.evidencePattern
  });
}

function mergeInstructions(members: GradedCandidateModule[]): string {
  const instructions = unique(
    [...members]
      .sort((left, right) => left.moduleId.localeCompare(right.moduleId))
      .map((member) => member.instruction.trim())
      .filter(Boolean)
  );
  return instructions.length === 1
    ? instructions[0]!
    : instructions.map((instruction, index) => `${index + 1}. ${instruction}`).join("\n");
}

function moduleFields(candidate: GradedCandidateModule) {
  return {
    semanticKey: candidate.semanticKey,
    type: candidate.type,
    instruction: candidate.instruction,
    scope: candidate.scope,
    triggerEvents: candidate.triggerEvents,
    ...(candidate.completionRule ? { completionRule: candidate.completionRule } : {}),
    requiredEvidence: candidate.requiredEvidence,
    ...(candidate.recovery ? { recovery: candidate.recovery } : {}),
    evidenceRefs: candidate.evidenceRefs,
    authority: candidate.authority,
    evidencePattern: candidate.evidencePattern
  };
}

function parseAlternativeGroups(value: unknown): AlternativeGroup[] {
  if (!Array.isArray(value)) throw new Error("direct-skill alternativeGroups must be an array");
  const names = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item)) throw new Error("direct-skill alternativeGroups contains invalid entry");
    const name = requiredText(item.groupKey, "alternativeGroups.groupKey");
    if (names.has(name)) throw new Error(`direct-skill alternativeGroups duplicated ${name}`);
    names.add(name);
    if (!Array.isArray(item.memberRefs) || item.memberRefs.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error("direct-skill alternativeGroups.memberRefs must be a string array");
    }
    return {
      groupKey: name,
      memberRefs: unique((item.memberRefs as string[]).map((entry) => entry.trim()))
    };
  });
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`direct-skill ${field} is required`);
  return value.trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sortedUnique<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort();
}
