import type { LlmClient } from "../../model/types.js";
import { createMemoryLogger } from "../../logging/logger.js";
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

const moduleExtractorLogger = createMemoryLogger("direct-skill-module-extractor");

const MODULE_EXTRACTION_PROMPT = `Extract all materially distinct, reusable, task-relevant modules from one trajectory span or one coherent turn.

Reject content that does not directly affect how the task is executed, verified, repaired, or submitted.
Use only the supplied trajectory. Never invent requirements, actions, results, or authority.
Each accepted module must satisfy at least one memory-strength definition:
- L1-worthy: task-relevant direction or background from which the agent can derive an action.
- L2-worthy: explicit executable advice or warning.
- L3-worthy: a trace-observable execution contract with trigger, action, completion rule, evidence, and recovery.
- L4-worthy: an authoritative hard task constraint explicitly present in the trajectory, with violation and recovery/stop behavior.
Do not assign a strength; a separate voter does that. Do not extract narration, incidental commands, or duplicates.
Concrete raw values from this trajectory, such as dates, amounts, totals, row numbers, cell values, file paths, or record identifiers, may appear in material.observation as source-grounded examples or evidence.
Do not turn those observed values into guidance: candidateModule.instruction, completionRule, requiredEvidence, and recovery must describe reusable actions, relationships, and verification methods without copying current-instance data. A literal explicitly stated as an invariant task constraint is not raw observed data and may be preserved only with aligned authorityEvidence.
For a coherent turn, prioritize the core solution that caused task success, then distinct verification, invariant, repair, avoidance, or fast-path knowledge. Multiple modules are allowed.
Each toolSteps entry contains the call, its result, and its exact evidenceRef. Copy that evidenceRef verbatim; do not invent or renumber evidence references.
Official evaluation confirms the overall task outcome only; do not claim it proves an action that is absent from the trace.
Each candidate evidenceRefs must refer only to the supplied source ID, a supplied tool-call id, or sourceId:tool:<zero-based-index>.
Set authorityEvidence only when that candidateModule.authority is task_hard_constraint; otherwise return null.
For a hard constraint, copy authorityEvidence.statement verbatim from the supplied trajectory and cite one supplied evidence reference.

Module type is one of: tactic, fast_path, avoidance, verification, repair, invariant.
When the supplied trajectory outcome is failure, candidateModule.type must be avoidance, repair, verification, or invariant; failure evidence cannot support tactic or fast_path.
triggerEvents may contain: turn_start, tool_error, no_progress, before_submit.
authority is one of: ordinary_experience, task_evidence, explicit_task_requirement, task_hard_constraint.
evidencePattern is one of: single_observation, repeated_consistent, success_failure_contrast, validator_confirmed, explicit_statement, mixed_or_uncertain.

Return JSON only:
{
  "decision": "accept" | "reject",
  "reason": "...",
  "modules": [{
    "material": {
      "subgoal": "...", "outcome": "success|failure|mixed",
      "observation": "...", "proposedAction": "...", "scopeClues": [],
      "evidenceRefs": [],
      "authorityEvidence": null | { "statement": "verbatim source text", "evidenceRef": "..." }
    },
    "candidateModule": {
      "semanticKey": "stable_snake_case_key", "type": "...", "instruction": "...",
      "scope": { "tasks": [], "tools": [], "resources": [], "operations": [] },
      "triggerEvents": [], "completionRule": "...", "requiredEvidence": [],
      "recovery": "...", "evidenceRefs": [], "authority": "...", "evidencePattern": "..."
    }
  }]
}`;

const MODULE_REPAIR_PROMPT = `Repair structurally invalid candidate modules using only the supplied trajectory source.

For each invalid module, preserve its semanticKey and intended guidance. Correct only the fields identified by validationErrors.
For task_hard_constraint authority, either provide an authorityEvidence statement copied verbatim from the source with a valid evidenceRef, or correct the authority when the source does not support a hard constraint.
Do not add unrelated modules, remove valid guidance, or invent evidence.

Return JSON only:
{ "modules": [{ "material": {...}, "candidateModule": {...} }] }`;

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

interface InvalidModuleDraft {
  value: unknown;
  semanticKey: string;
  reason: string;
}

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
      maxTokens: 8192
    });
    if (result.decision === "reject") {
      return { decision: "reject", reason: requiredText(result.reason, "reject reason") };
    }
    if (result.decision !== "accept") throw new Error("direct-skill extractor returned invalid decision");
    if (!Array.isArray(result.modules) || result.modules.length === 0) {
      throw new Error("direct-skill extractor accepted without modules");
    }
    const semanticKeys = new Set<string>();
    const parsed = parseModuleDrafts(result.modules, source, semanticKeys);
    const modules = [...parsed.modules];
    let unresolved = parsed.invalid;
    if (unresolved.length > 0) {
      try {
        const repaired = await this.llm.completeJson<Record<string, unknown>>([
          { role: "system", content: MODULE_REPAIR_PROMPT },
          {
            role: "user",
            content: stableStringify({
              source,
              invalidModules: unresolved.map((item) => ({
                semanticKey: item.semanticKey,
                validationError: item.reason,
                module: item.value
              }))
            })
          }
        ], {
          operation: "direct_skill.module.repair",
          jsonMode: true,
          temperature: 0.2,
          maxTokens: 8192
        });
        if (!Array.isArray(repaired.modules)) {
          throw new Error("direct-skill Module repair omitted modules");
        }
        const expectedKeys = new Set(unresolved.map((item) => item.semanticKey));
        const repairValues = repaired.modules.filter((value) =>
          isRecord(value) && isRecord(value.candidateModule) &&
          typeof value.candidateModule.semanticKey === "string" &&
          expectedKeys.has(value.candidateModule.semanticKey)
        );
        const repairParsed = parseModuleDrafts(repairValues, source, semanticKeys);
        modules.push(...repairParsed.modules);
        const repairedKeys = new Set(repairParsed.modules.map((item) => item.candidateModule.semanticKey));
        unresolved = [
          ...repairParsed.invalid,
          ...unresolved.filter((item) => !repairedKeys.has(item.semanticKey) &&
            !repairParsed.invalid.some((failure) => failure.semanticKey === item.semanticKey))
        ];
      } catch (error) {
        unresolved = unresolved.map((item) => ({
          ...item,
          reason: `${item.reason}; repair failed: ${errorMessage(error)}`
        }));
      }
    }
    if (unresolved.length > 0) {
      moduleExtractorLogger.warn("repair.failed", {
        operation: "direct_skill.module.repair",
        episodeId: source.episodeId,
        sourceType: source.sourceType,
        sourceId: source.sourceId,
        semanticKeys: unresolved.map((item) => item.semanticKey),
        reasons: unresolved.map((item) => item.reason)
      });
      if (modules.length === 0) {
        throw new Error(`direct-skill Module repair failed: ${unresolved.map((item) =>
          `${item.semanticKey}: ${item.reason}`).join("; ")}`);
      }
    }
    return {
      decision: "accept",
      modules
    };
  }
}

function parseModuleDrafts(
  values: unknown[],
  source: DirectSkillExtractionSource,
  semanticKeys: Set<string>
): {
  modules: Array<Extract<SpanModuleExtractionResult, { decision: "accept" }>["modules"][number]>;
  invalid: InvalidModuleDraft[];
} {
  const modules: Array<Extract<SpanModuleExtractionResult, { decision: "accept" }>["modules"][number]> = [];
  const invalid: InvalidModuleDraft[] = [];
  values.forEach((value, index) => {
    const semanticKey = isRecord(value) && isRecord(value.candidateModule) &&
      typeof value.candidateModule.semanticKey === "string" && value.candidateModule.semanticKey.trim()
      ? value.candidateModule.semanticKey.trim()
      : `module_index_${index}`;
    try {
      if (!isRecord(value) || !isRecord(value.candidateModule)) {
        throw new Error("direct-skill extractor returned invalid module entry");
      }
      if (semanticKeys.has(semanticKey)) {
        throw new Error(`direct-skill extractor duplicated semanticKey: ${semanticKey}`);
      }
      const material = parseMaterial(
        value.material,
        source,
        semanticKey,
        value.candidateModule.authority === "task_hard_constraint"
      );
      const candidate = parseCandidate(value.candidateModule, source, material);
      semanticKeys.add(semanticKey);
      modules.push({
        material,
        candidateModule: {
          ...candidate,
          moduleId: `dsm_${stableHash(`${source.episodeId}:${source.sourceId}:${candidate.semanticKey}`).slice(0, 20)}`,
          material
        }
      });
    } catch (error) {
      invalid.push({ value, semanticKey, reason: errorMessage(error) });
    }
  });
  return { modules, invalid };
}

function parseMaterial(
  value: unknown,
  source: DirectSkillExtractionSource,
  semanticKey: string,
  requiresAuthorityEvidence: boolean
): ModuleMaterial {
  if (!isRecord(value)) throw new Error("direct-skill extractor returned invalid material");
  const evidenceRefs = parseEvidenceRefs(value.evidenceRefs, "material.evidenceRefs", source);
  let authorityEvidence: ModuleMaterial["authorityEvidence"];
  if (value.authorityEvidence !== undefined && value.authorityEvidence !== null) {
    try {
      authorityEvidence = parseAuthorityEvidence(value.authorityEvidence, source);
    } catch (error) {
      if (requiresAuthorityEvidence) {
        throw new Error(
          `direct-skill hard constraint authorityEvidence is invalid, semanticKey=${semanticKey}, ` +
          `reason=${errorMessage(error)}`
        );
      }
      // Non-hard modules do not consume authorityEvidence.
      authorityEvidence = undefined;
    }
  } else if (requiresAuthorityEvidence) {
    throw new Error(
      `direct-skill hard constraint omitted authorityEvidence, semanticKey=${semanticKey}`
    );
  }
  return {
    materialId: `dsmat_${stableHash(`${source.episodeId}:${source.sourceId}:${semanticKey}`).slice(0, 20)}`,
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
  const evidenceRefs = parseEvidenceRefs(value.evidenceRefs, "candidateModule.evidenceRefs", source);
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
  const evidenceRef = parseEvidenceRefs(
    [requiredText(value.evidenceRef, "authorityEvidence.evidenceRef")],
    "authorityEvidence.evidenceRef",
    source
  )[0]!;
  const haystack = stableStringify(source);
  if (!haystack.includes(statement)) {
    throw new Error("direct-skill authority statement is not present in source evidence");
  }
  return { statement, evidenceRef };
}

function parseEvidenceRefs(value: unknown, field: string, source: DirectSkillExtractionSource): string[] {
  const refs = stringArray(value, field).map((ref) =>
    ref.startsWith("sourceId:tool:") ? `${source.sourceId}:tool:${ref.slice("sourceId:tool:".length)}` : ref
  );
  validateEvidenceRefs(refs, source);
  return refs;
}

function validateEvidenceRefs(refs: string[], source: DirectSkillExtractionSource): void {
  if (refs.length === 0) throw new Error("direct-skill evidenceRefs must not be empty");
  const indexedRefs = new Set(source.toolSteps.map((step) => step.evidenceRef));
  const toolCallIds = new Set(source.toolSteps.flatMap((step) =>
    isRecord(step.call) && typeof step.call.id === "string" && step.call.id.trim() ? [step.call.id.trim()] : []
  ));
  for (const ref of refs) {
    if (ref === source.sourceId) continue;
    if (toolCallIds.has(ref)) continue;
    if (!indexedRefs.has(ref)) throw new Error(`direct-skill evidence ref is outside source: ${ref}`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
