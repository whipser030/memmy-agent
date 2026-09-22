import type { LlmClient } from "../../model/types.js";
import { newId, stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import { StrengthVoter } from "./strength-voter.js";
import type {
  CandidateModuleRecord,
  DirectSkillModule,
  DirectSkillPackage,
  GradedCandidateModule
} from "./types.js";

const PACKAGE_CONSOLIDATION_PROMPT = `Organize all graded modules in one skill package.

mergeGroups may merge modules only when semanticKey, type, and strength are equal and scope plus execution contract are compatible.
alternativeGroups identify solutions to a similar problem that cannot be used together. Do not merge alternatives.
Every alternative member must reference either a merge group ID or an unmerged candidate module ID.
Do not invent, delete, or rewrite modules.

Return JSON only:
{
  "title": "...", "summary": "...",
  "mergeGroups": [{ "groupId": "...", "candidateModuleIds": ["..."] }],
  "alternativeGroups": [{ "groupKey": "...", "memberRefs": ["..."] }]
}`;

interface MergeGroup {
  groupId: string;
  candidateModuleIds: string[];
}

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
    const organization = await this.consolidate(packageId, graded);
    const modules = buildFinalModules(graded, organization.mergeGroups, organization.alternativeGroups);
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

  private async consolidate(packageId: string, graded: GradedCandidateModule[]): Promise<{
    title: string;
    summary: string;
    mergeGroups: MergeGroup[];
    alternativeGroups: AlternativeGroup[];
  }> {
    const result = await this.llm.completeJson<Record<string, unknown>>([
      { role: "system", content: PACKAGE_CONSOLIDATION_PROMPT },
      {
        role: "user",
        content: stableStringify({
          packageId,
          modules: graded.map(({ material, ...candidate }) => ({ candidate, evidenceSummary: material.observation }))
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
      mergeGroups: parseGroups(result.mergeGroups, "mergeGroups", "groupId", "candidateModuleIds"),
      alternativeGroups: parseGroups(result.alternativeGroups, "alternativeGroups", "groupKey", "memberRefs")
    };
  }
}

function buildFinalModules(
  candidates: GradedCandidateModule[],
  mergeGroups: MergeGroup[],
  alternativeGroups: AlternativeGroup[]
): DirectSkillModule[] {
  const byId = new Map(candidates.map((candidate) => [candidate.moduleId, candidate]));
  const consumed = new Set<string>();
  const unitToModules = new Map<string, DirectSkillModule[]>();
  const modules: DirectSkillModule[] = [];

  for (const group of mergeGroups) {
    if (group.candidateModuleIds.length < 2) throw new Error(`direct-skill merge group ${group.groupId} must have at least two members`);
    const members = group.candidateModuleIds.map((id) => {
      const candidate = byId.get(id);
      if (!candidate) throw new Error(`direct-skill merge group references unknown module: ${id}`);
      if (consumed.has(id)) throw new Error(`direct-skill module belongs to multiple merge groups: ${id}`);
      consumed.add(id);
      return candidate;
    });
    assertMergeCompatible(members);
    const first = members[0]!;
    const merged: DirectSkillModule = {
      ...moduleFields(first),
      instruction: mergeInstructions(members),
      moduleId: `dsmg_${group.groupId}`,
      strength: first.strengthDecision.finalStrength,
      evidenceRefs: unique(members.flatMap((member) => member.evidenceRefs)),
      sourceModuleIds: members.map((member) => member.moduleId),
      strengthDecisions: members.map((member) => member.strengthDecision)
    };
    modules.push(merged);
    unitToModules.set(group.groupId, [merged]);
  }

  for (const candidate of candidates) {
    if (consumed.has(candidate.moduleId)) continue;
    const module: DirectSkillModule = {
      ...moduleFields(candidate),
      moduleId: candidate.moduleId,
      strength: candidate.strengthDecision.finalStrength,
      sourceModuleIds: [candidate.moduleId],
      strengthDecisions: [candidate.strengthDecision]
    };
    modules.push(module);
    unitToModules.set(candidate.moduleId, [module]);
  }

  const assignedAlternative = new Set<string>();
  for (const group of alternativeGroups) {
    if (group.memberRefs.length < 2) throw new Error(`direct-skill alternative group ${group.groupKey} must have at least two members`);
    for (const ref of group.memberRefs) {
      const members = unitToModules.get(ref);
      if (!members) throw new Error(`direct-skill alternative group references unknown unit: ${ref}`);
      for (const module of members) {
        if (assignedAlternative.has(module.moduleId)) {
          throw new Error(`direct-skill module belongs to multiple alternative groups: ${module.moduleId}`);
        }
        module.alternativeGroupKey = group.groupKey;
        assignedAlternative.add(module.moduleId);
      }
    }
  }
  return modules;
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

function assertMergeCompatible(members: GradedCandidateModule[]): void {
  const first = members[0]!;
  const contract = stableStringify({
    scope: first.scope,
    triggerEvents: [...first.triggerEvents].sort(),
    completionRule: first.completionRule ?? null,
    requiredEvidence: first.requiredEvidence,
    recovery: first.recovery ?? null
  });
  for (const member of members.slice(1)) {
    if (
      member.semanticKey !== first.semanticKey ||
      member.type !== first.type ||
      member.strengthDecision.finalStrength !== first.strengthDecision.finalStrength
    ) {
      throw new Error("direct-skill merge group contains different semanticKey, type, or strength");
    }
    const nextContract = stableStringify({
      scope: member.scope,
      triggerEvents: [...member.triggerEvents].sort(),
      completionRule: member.completionRule ?? null,
      requiredEvidence: member.requiredEvidence,
      recovery: member.recovery ?? null
    });
    if (nextContract !== contract) throw new Error("direct-skill merge group contains incompatible scope or contract");
  }
}

function parseGroups<TName extends "groupId" | "groupKey", TMembers extends "candidateModuleIds" | "memberRefs">(
  value: unknown,
  field: string,
  nameField: TName,
  membersField: TMembers
): Array<Record<TName, string> & Record<TMembers, string[]>> {
  if (!Array.isArray(value)) throw new Error(`direct-skill ${field} must be an array`);
  const names = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item)) throw new Error(`direct-skill ${field} contains invalid entry`);
    const name = requiredText(item[nameField], `${field}.${nameField}`);
    if (names.has(name)) throw new Error(`direct-skill ${field} duplicated ${name}`);
    names.add(name);
    if (!Array.isArray(item[membersField]) || item[membersField].some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error(`direct-skill ${field}.${membersField} must be a string array`);
    }
    return { [nameField]: name, [membersField]: unique((item[membersField] as string[]).map((entry) => entry.trim())) } as Record<TName, string> & Record<TMembers, string[]>;
  });
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`direct-skill ${field} is required`);
  return value.trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
