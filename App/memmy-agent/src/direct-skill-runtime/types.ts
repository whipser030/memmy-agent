export type DirectSkillMode = "off" | "legacy" | "package_v1";
export type DirectSkillInterventionMode = "static" | "dynamic" | "full";

export type DirectSkillEventType = "turn_start" | "tool_error" | "no_progress" | "before_submit";

export type RuntimeEventBatch = {
  eventTypes: DirectSkillEventType[];
  occurredAt: string;
  toolCalls?: Record<string, any>[];
  toolResults?: any[];
  toolEvents?: Record<string, any>[];
  draftFinalAnswer?: string;
};

export type DirectSkillModule = {
  moduleId: string;
  type?: string;
  strength?: "L1" | "L2" | "L3" | "L4";
  instruction: string;
  triggerEvents: DirectSkillEventType[];
  scope?: { tools?: string[]; toolNames?: string[]; [key: string]: any } | null;
  completionRule?: string | Record<string, any> | null;
  requiredEvidence?: Array<string | Record<string, any>>;
  recovery?: string | null;
  alternativeGroupKey?: string | null;
  [key: string]: any;
};

export type DirectSkillPackage = {
  packageId: string;
  title?: string;
  modules: DirectSkillModule[];
  [key: string]: any;
};

export type DirectSkillIntervention = {
  taskKey: string;
  packageId: string;
  eventTypes: DirectSkillEventType[];
  moduleIds: string[];
  injectedAt: string;
};

export type DirectSkillInjection = {
  content: string;
  directSkillIntervention: DirectSkillIntervention;
};

export type DirectSkillTaskState = {
  taskKey: string;
  package: DirectSkillPackage | null;
  recentToolSignatures: string[];
  emittedFingerprints: Set<string>;
  injectedModuleIds: Set<string>;
  beforeSubmitIntervened: boolean;
};
