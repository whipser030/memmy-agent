import type { LlmClient } from "../../model/types.js";
import { stableHash, stableStringify } from "../../utils/id.js";
import { isRecord } from "../../utils/json.js";
import {
  MODULE_TYPES,
  RETRIEVAL_EVENT_TYPES,
  type AuthoritySource,
  type CandidateModule,
  type DirectSkillExtractionSource,
  type EvidencePattern,
  type ModuleMaterial,
  type ModuleScope,
  type SpanModuleExtractionResult
} from "./types.js";

const MODULE_EXTRACTION_PROMPT = `Extract one reusable, task-relevant module from one trajectory span or one coherent turn.

Reject content that does not directly affect how the task is executed, verified, repaired, or submitted.
Use only the supplied trajectory. Never invent requirements, actions, results, or authority.
Return exactly one material and exactly one candidateModule when accepted.
The candidate evidenceRefs must refer only to the supplied source ID or its tool-call references.
An authorityEvidence statement must be copied from the supplied trajectory and must cite one supplied evidence reference.

Module type is one of: tactic, fast_path, avoidance, verification, repair, invariant.
When the supplied trajectory outcome is failure, candidateModule.type must be avoidance, repair, verification, or invariant; failure evidence cannot support tactic or fast_path.
triggerEvents may contain: turn_start, tool_error, no_progress, before_submit.
authority is one of: ordinary_experience, task_evidence, explicit_task_requirement, task_hard_constraint.
evidencePattern is one of: single_observation, repeated_consistent, success_failure_contrast, validator_confirmed, explicit_statement, mixed_or_uncertain.

Return JSON only:
{
  "decision": "accept" | "reject",
  "reason": "...",
  "material": {
    "subgoal": "...", "outcome": "success|failure|mixed",
    "observation": "...", "proposedAction": "...", "scopeClues": [],
    "evidenceRefs": [],
    "authorityEvidence": { "statement": "...", "evidenceRef": "..." }
  },
  "candidateModule": {
    "semanticKey": "stable_snake_case_key", "type": "...", "instruction": "...",
    "scope": { "tasks": [], "tools": [], "resources": [], "operations": [] },
    "triggerEvents": [], "completionRule": "...", "requiredEvidence": [],
    "recovery": "...", "evidenceRefs": [], "authority": "...", "evidencePattern": "..."
  }
}`;

const AUTHORITIES: AuthoritySource[] = [
  "ordinary_experience",
  "task_evidence",
  "explicit_task_requirement",
  "task_hard_constraint"
];

const EVIDENCE_PATTERNS: EvidencePattern[] = [
  "single_observation",
  "repeated_consistent",
  "success_failure_contrast",
  "validator_confirmed",
  "explicit_statement",
  "mixed_or_uncertain"
];

export class ModuleExtractor {
  constructor(private readonly llm: LlmClient) {}

  extractFromSpan(source: DirectSkillExtractionSource): Promise<SpanModuleExtractionResult> {
    if (source.sourceType !== "span") throw new Error("direct-skill span extractor requires a span source");
    return this.extract(source);
  }

  extractFromTurn(source: DirectSkillExtractionSource): Promise<SpanModuleExtractionResult> {
    if (source.sourceType !== "turn") throw new Error("direct-skill turn extractor requires a turn source");
    return this.extract(source);
  }

  private async extract(source: DirectSkillExtractionSource): Promise<SpanModuleExtractionResult> {
    if (!this.llm.isConfigured()) throw new Error("direct-skill module extraction requires a configured LLM");
    const result = await this.llm.completeJson<Record<string, unknown>>([
      { role: "system", content: MODULE_EXTRACTION_PROMPT },
      { role: "user", content: stableStringify(source) }
    ], {
      operation: source.sourceType === "span"
        ? "direct_skill.module.extract_span"
        : "direct_skill.module.extract_turn",
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 4096
    });
    if (result.decision === "reject") {
      return { decision: "reject", reason: requiredText(result.reason, "reject reason") };
    }
    if (result.decision !== "accept") throw new Error("direct-skill extractor returned invalid decision");
    const material = parseMaterial(result.material, source);
    const candidate = parseCandidate(result.candidateModule, source, material);
    return {
      decision: "accept",
      material,
      candidateModule: {
        ...candidate,
        moduleId: `dsm_${stableHash(`${source.episodeId}:${source.sourceId}:${candidate.semanticKey}`).slice(0, 20)}`,
        material
      }
    };
  }
}

function parseMaterial(value: unknown, source: DirectSkillExtractionSource): ModuleMaterial {
  if (!isRecord(value)) throw new Error("direct-skill extractor returned invalid material");
  const evidenceRefs = stringArray(value.evidenceRefs, "material.evidenceRefs");
  validateEvidenceRefs(evidenceRefs, source);
  const authorityEvidence = value.authorityEvidence === undefined || value.authorityEvidence === null
    ? undefined
    : parseAuthorityEvidence(value.authorityEvidence, source);
  return {
    materialId: `dsmat_${stableHash(`${source.episodeId}:${source.sourceId}`).slice(0, 20)}`,
    ...(source.sourceType === "span" ? { spanId: source.sourceId } : { rawTurnId: source.sourceId }),
    episodeId: source.episodeId,
    subgoal: requiredText(value.subgoal, "material.subgoal"),
    outcome: enumValue(value.outcome, ["success", "failure", "mixed"] as const, "material.outcome"),
    observation: requiredText(value.observation, "material.observation"),
    proposedAction: requiredText(value.proposedAction, "material.proposedAction"),
    scopeClues: stringArray(value.scopeClues, "material.scopeClues"),
    evidenceRefs,
    ...(authorityEvidence ? { authorityEvidence } : {})
  };
}

function parseCandidate(
  value: unknown,
  source: DirectSkillExtractionSource,
  material: ModuleMaterial
): CandidateModule {
  if (!isRecord(value)) throw new Error("direct-skill extractor returned invalid candidateModule");
  const semanticKey = requiredText(value.semanticKey, "candidateModule.semanticKey");
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(semanticKey)) {
    throw new Error("direct-skill semanticKey must be stable snake_case");
  }
  const evidenceRefs = stringArray(value.evidenceRefs, "candidateModule.evidenceRefs");
  validateEvidenceRefs(evidenceRefs, source);
  if (evidenceRefs.some((ref) => !material.evidenceRefs.includes(ref))) {
    throw new Error("direct-skill candidate evidence must be present in its material");
  }
  const authority = enumValue(value.authority, AUTHORITIES, "candidateModule.authority");
  if (authority === "task_hard_constraint" && !material.authorityEvidence) {
    throw new Error("direct-skill hard constraint requires aligned authority evidence");
  }
  return {
    semanticKey,
    type: enumValue(value.type, MODULE_TYPES, "candidateModule.type"),
    instruction: requiredText(value.instruction, "candidateModule.instruction"),
    scope: parseScope(value.scope),
    triggerEvents: unique(enumArray(value.triggerEvents, RETRIEVAL_EVENT_TYPES, "candidateModule.triggerEvents")),
    ...(optionalText(value.completionRule) ? { completionRule: optionalText(value.completionRule) } : {}),
    requiredEvidence: stringArray(value.requiredEvidence, "candidateModule.requiredEvidence"),
    ...(optionalText(value.recovery) ? { recovery: optionalText(value.recovery) } : {}),
    evidenceRefs,
    authority,
    evidencePattern: enumValue(value.evidencePattern, EVIDENCE_PATTERNS, "candidateModule.evidencePattern")
  };
}

function parseScope(value: unknown): ModuleScope {
  if (!isRecord(value)) throw new Error("direct-skill candidate scope is invalid");
  return {
    tasks: stringArray(value.tasks, "scope.tasks"),
    tools: stringArray(value.tools, "scope.tools"),
    resources: stringArray(value.resources, "scope.resources"),
    operations: stringArray(value.operations, "scope.operations")
  };
}

function parseAuthorityEvidence(value: unknown, source: DirectSkillExtractionSource) {
  if (!isRecord(value)) throw new Error("direct-skill authorityEvidence is invalid");
  const statement = requiredText(value.statement, "authorityEvidence.statement");
  const evidenceRef = requiredText(value.evidenceRef, "authorityEvidence.evidenceRef");
  validateEvidenceRefs([evidenceRef], source);
  const haystack = stableStringify(source);
  if (!haystack.includes(statement)) {
    throw new Error("direct-skill authority statement is not present in source evidence");
  }
  return { statement, evidenceRef };
}

function validateEvidenceRefs(refs: string[], source: DirectSkillExtractionSource): void {
  if (refs.length === 0) throw new Error("direct-skill evidenceRefs must not be empty");
  const prefix = `${source.sourceId}:tool:`;
  for (const ref of refs) {
    if (ref === source.sourceId) continue;
    if (!ref.startsWith(prefix)) throw new Error(`direct-skill evidence ref is outside source: ${ref}`);
    const index = Number(ref.slice(prefix.length));
    if (!Number.isInteger(index) || index < 0 || index >= source.toolCalls.length) {
      throw new Error(`direct-skill tool evidence ref is invalid: ${ref}`);
    }
  }
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`direct-skill ${field} must be a string array`);
  }
  return unique(value.map((item) => item.trim()));
}

function enumArray<T extends string>(value: unknown, allowed: readonly T[], field: string): T[] {
  if (!Array.isArray(value)) throw new Error(`direct-skill ${field} must be an array`);
  return value.map((item) => enumValue(item, allowed, field));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`direct-skill ${field} is invalid`);
  }
  return value as T;
}

function requiredText(value: unknown, field: string): string {
  const parsed = optionalText(value);
  if (!parsed) throw new Error(`direct-skill ${field} is required`);
  return parsed;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
