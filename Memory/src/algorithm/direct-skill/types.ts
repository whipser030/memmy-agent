export const MODULE_TYPES = [
  "tactic",
  "fast_path",
  "avoidance",
  "verification",
  "repair",
  "invariant"
] as const;

export type ModuleType = typeof MODULE_TYPES[number];

export const SKILL_STRENGTHS = ["L1", "L2", "L3", "L4"] as const;
export type SkillStrength = typeof SKILL_STRENGTHS[number];

export const RETRIEVAL_EVENT_TYPES = [
  "turn_start",
  "tool_error",
  "no_progress",
  "before_submit"
] as const;

export type RetrievalEventType = typeof RETRIEVAL_EVENT_TYPES[number];

export type AuthoritySource =
  | "ordinary_experience"
  | "task_evidence"
  | "explicit_task_requirement"
  | "task_hard_constraint";

export type EvidencePattern =
  | "single_observation"
  | "repeated_consistent"
  | "success_failure_contrast"
  | "validator_confirmed"
  | "explicit_statement"
  | "mixed_or_uncertain";

export type ConstraintMode = "reference" | "advisory" | "required" | "hard_constraint";
export type GuideSpecificity = "directional" | "actionable" | "execution_contract";
export type Observability = "unobservable" | "agent_reported" | "trace_observable";

export interface ModuleScope {
  tasks: string[];
  tools: string[];
  resources: string[];
  operations: string[];
}

export interface ModuleMaterial {
  materialId: string;
  spanId?: string;
  rawTurnId?: string;
  episodeId: string;
  subgoal: string;
  outcome: "success" | "failure" | "mixed";
  observation: string;
  proposedAction: string;
  scopeClues: string[];
  evidenceRefs: string[];
  authorityEvidence?: {
    statement: string;
    evidenceRef: string;
  };
}

export interface CandidateModule {
  semanticKey: string;
  type: ModuleType;
  instruction: string;
  scope: ModuleScope;
  triggerEvents: RetrievalEventType[];
  completionRule?: string;
  requiredEvidence: string[];
  recovery?: string;
  evidenceRefs: string[];
  authority: AuthoritySource;
  evidencePattern: EvidencePattern;
}

export interface CandidateModuleRecord extends CandidateModule {
  moduleId: string;
  material: ModuleMaterial;
}

export type SpanModuleExtractionResult =
  | { decision: "reject"; reason: string }
  | {
      decision: "accept";
      modules: Array<{
        material: ModuleMaterial;
        candidateModule: CandidateModuleRecord;
      }>;
    };

export interface StrengthVote {
  moduleId: string;
  constraintMode: ConstraintMode;
  guideSpecificity: GuideSpecificity;
  authority: AuthoritySource;
  observability: Observability;
  strength: SkillStrength;
  reason: string;
}

export interface StrengthDecision {
  moduleId: string;
  votes: [StrengthVote, StrengthVote, StrengthVote];
  finalStrength: SkillStrength;
  aggregation: "majority" | "median";
}

export interface GradedCandidateModule extends CandidateModuleRecord {
  strengthDecision: StrengthDecision;
}

export interface DirectSkillModule extends CandidateModule {
  moduleId: string;
  strength: SkillStrength;
  alternativeGroupKey?: string;
  sourceModuleIds: string[];
  strengthDecisions: StrengthDecision[];
}

export interface DirectSkillPackage {
  schemaVersion: 1;
  packageId: string;
  clusterId: string;
  title: string;
  summary: string;
  status: "frozen";
  modules: DirectSkillModule[];
  sourceEpisodeIds: string[];
  createdAt: string;
}

export interface DirectSkillExtractionSource {
  sourceType: "span" | "turn";
  sourceId: string;
  episodeId: string;
  outcome: "success" | "failure" | "mixed";
  userRequest: string;
  assistantFinalAnswer: string;
  subgoal: string;
  summary: string;
  toolSteps: Array<{
    evidenceRef: string;
    call: unknown;
    result: unknown;
  }>;
  evaluation: {
    rTask: number;
    detail: Record<string, unknown>;
  };
}
