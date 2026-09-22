import type { LlmClient } from "../../model/types.js";
import { stableHash, stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import {
  SKILL_STRENGTHS,
  type AuthoritySource,
  type CandidateModuleRecord,
  type ConstraintMode,
  type GradedCandidateModule,
  type GuideSpecificity,
  type Observability,
  type SkillStrength,
  type StrengthDecision,
  type StrengthVote
} from "./types.js";

const STRENGTH_REVIEW_PROMPT = `Grade every candidate module in this package. Do not omit or add IDs.

Use only these fixed definitions:
- L1: task-relevant direction or background; the agent must derive the concrete action.
- L2: explicit executable advice or warning, but the agent may choose not to follow it.
- L3: a required and trace-observable execution contract with trigger, action, completion rule, evidence, and recovery.
- L4: an authoritative hard task constraint explicitly present in the supplied trajectory evidence, including violation and recovery/stop behavior.

Frequency, success rate, module type, and amount of evidence never raise strength.
Judge the module as written. Do not rewrite it.

Return JSON only:
{ "votes": [{
  "moduleId": "...",
  "constraintMode": "reference|advisory|required|hard_constraint",
  "guideSpecificity": "directional|actionable|execution_contract",
  "authority": "ordinary_experience|task_evidence|explicit_task_requirement|task_hard_constraint",
  "observability": "unobservable|agent_reported|trace_observable",
  "strength": "L1|L2|L3|L4",
  "reason": "..."
}] }`;

const CONSTRAINT_MODES: ConstraintMode[] = ["reference", "advisory", "required", "hard_constraint"];
const GUIDE_SPECIFICITIES: GuideSpecificity[] = ["directional", "actionable", "execution_contract"];
const AUTHORITIES: AuthoritySource[] = [
  "ordinary_experience",
  "task_evidence",
  "explicit_task_requirement",
  "task_hard_constraint"
];
const OBSERVABILITIES: Observability[] = ["unobservable", "agent_reported", "trace_observable"];

export class StrengthVoter {
  constructor(private readonly llm: LlmClient) {}

  async grade(packageId: string, candidates: CandidateModuleRecord[]): Promise<GradedCandidateModule[]> {
    if (candidates.length === 0) return [];
    if (!this.llm.isConfigured()) throw new Error("direct-skill strength voting requires a configured LLM");
    const voteSets = await Promise.all([0, 1, 2].map((voteIndex) =>
      this.reviewOnce(packageId, voteIndex, deterministicShuffle(candidates, `${packageId}:${voteIndex}`))
    ));
    return candidates.map((candidate) => ({
      ...candidate,
      strengthDecision: aggregateVotes(candidate.moduleId, voteSets.map((votes) => votes.get(candidate.moduleId)!))
    }));
  }

  private async reviewOnce(
    packageId: string,
    voteIndex: number,
    candidates: CandidateModuleRecord[]
  ): Promise<Map<string, StrengthVote>> {
    const result = await this.llm.completeJson<Record<string, unknown>>([
      { role: "system", content: STRENGTH_REVIEW_PROMPT },
      {
        role: "user",
        content: stableStringify({
          packageId,
          candidates: candidates.map(({ material, ...candidate }) => ({ candidate, evidence: material }))
        })
      }
    ], {
      operation: "direct_skill.strength.review",
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 8192
    });
    if (!Array.isArray(result.votes)) throw new Error(`direct-skill vote ${voteIndex} omitted votes`);
    const expected = new Set(candidates.map((candidate) => candidate.moduleId));
    const votes = new Map<string, StrengthVote>();
    for (const value of result.votes) {
      const vote = parseVote(value);
      if (!expected.has(vote.moduleId)) throw new Error(`direct-skill vote returned unknown ID: ${vote.moduleId}`);
      if (votes.has(vote.moduleId)) throw new Error(`direct-skill vote duplicated ID: ${vote.moduleId}`);
      votes.set(vote.moduleId, vote);
    }
    if (votes.size !== expected.size) throw new Error(`direct-skill vote ${voteIndex} did not return every module ID`);
    return votes;
  }
}

export function aggregateVotes(moduleId: string, votes: StrengthVote[]): StrengthDecision {
  if (votes.length !== 3 || votes.some((vote) => vote.moduleId !== moduleId)) {
    throw new Error(`direct-skill requires exactly three aligned votes for ${moduleId}`);
  }
  const counts = new Map<SkillStrength, number>();
  for (const vote of votes) counts.set(vote.strength, (counts.get(vote.strength) ?? 0) + 1);
  const majority = [...counts.entries()].find(([, count]) => count >= 2)?.[0];
  const finalStrength = majority ?? [...votes]
    .sort((a, b) => strengthNumber(a.strength) - strengthNumber(b.strength))[1]!.strength;
  return {
    moduleId,
    votes: votes as [StrengthVote, StrengthVote, StrengthVote],
    finalStrength,
    aggregation: majority ? "majority" : "median"
  };
}

function parseVote(value: unknown): StrengthVote {
  if (!isRecord(value)) throw new Error("direct-skill vote is invalid");
  return {
    moduleId: requiredText(value.moduleId, "moduleId"),
    constraintMode: enumValue(value.constraintMode, CONSTRAINT_MODES, "constraintMode"),
    guideSpecificity: enumValue(value.guideSpecificity, GUIDE_SPECIFICITIES, "guideSpecificity"),
    authority: enumValue(value.authority, AUTHORITIES, "authority"),
    observability: enumValue(value.observability, OBSERVABILITIES, "observability"),
    strength: enumValue(value.strength, SKILL_STRENGTHS, "strength"),
    reason: requiredText(value.reason, "reason")
  };
}

function deterministicShuffle<T>(values: T[], seed: string): T[] {
  return values
    .map((value, index) => ({ value, index, key: stableHash(`${seed}:${index}`) }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index)
    .map((item) => item.value);
}

function strengthNumber(value: SkillStrength): number {
  return SKILL_STRENGTHS.indexOf(value) + 1;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`direct-skill vote ${field} is invalid`);
  }
  return value as T;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`direct-skill vote ${field} is required`);
  return value.trim();
}
