import { compileRetrievalQuery } from "../../algorithm/plugin-algorithms.js";
import type { DirectSkillModule, DirectSkillPackage } from "../../algorithm/direct-skill/types.js";
import type { MemmyConfig } from "../../config/index.js";
import type { Embedder, LlmClient } from "../../model/types.js";
import { Repositories } from "../../storage/repositories.js";
import type {
  MemoryRow,
  RouteDirectSkillPackageRequest,
  RouteDirectSkillPackageResponse,
  RuntimeNamespace,
  SelectDirectSkillModulesRequest,
  SelectDirectSkillModulesResponse
} from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { IndexedCandidatePool } from "../retrieval/indexed-candidate-pool.js";
import { DIRECT_SKILL_PACKAGE_TAG } from "../retrieval/retrieval-service.js";

const RUNTIME_MANAGED_MARKER = "direct_skill_v1";
const ROUTE_CANDIDATE_LIMIT = 8;
const MODEL_TIMEOUT_MS = 30_000;

interface DirectSkillRetrievalDependencies {
  repos: Repositories;
  readonly config: MemmyConfig;
  readonly skillLlm: LlmClient;
  readonly embedder: Embedder;
  resolveContext(request: { namespace?: RuntimeNamespace }): {
    userId: string;
    namespace: RuntimeNamespace;
  };
  memoryHasImportPipeline(memory: MemoryRow): boolean;
}

export class DirectSkillRetrievalService {
  private readonly candidatePool: IndexedCandidatePool;

  constructor(private readonly deps: DirectSkillRetrievalDependencies) {
    this.candidatePool = new IndexedCandidatePool(deps);
  }

  async routePackage(request: RouteDirectSkillPackageRequest): Promise<RouteDirectSkillPackageResponse> {
    const query = request.query.trim();
    if (!query || this.deps.config.algorithm.skill.directMode !== "package_v1") {
      return { package: null };
    }
    const context = this.deps.resolveContext(request);
    const retrieval = this.deps.config.algorithm.retrieval;
    const filter = {
      tier1TopK: Math.max(ROUTE_CANDIDATE_LIMIT, retrieval.tier1TopK),
      tier2TopK: retrieval.tier2TopK,
      tier3TopK: retrieval.tier3TopK,
      candidatePoolFactor: retrieval.candidatePoolFactor,
      keywordTopK: retrieval.keywordTopK,
      tagFilter: retrieval.tagFilter
    };
    const compiledQuery = compileRetrievalQuery(query, null, { domain: this.deps.config.domain });
    const hasVectors = this.candidatePool.hasRetrievalVectorCandidates({
      userId: context.userId,
      layers: ["Skill"],
      tags: [DIRECT_SKILL_PACKAGE_TAG],
      scopeUserId: true
    });
    let queryVector: number[] | undefined;
    if (hasVectors) {
      try {
        queryVector = await this.deps.embedder.embedOne(query, "query");
      } catch {
        // FTS and pattern routes remain available when query embedding is unavailable.
      }
    }
    const pool = await this.candidatePool.indexedRetrievalCandidatePool({
      userId: context.userId,
      compiledQuery,
      queryVector,
      layers: ["Skill"],
      tags: [DIRECT_SKILL_PACKAGE_TAG],
      scopeUserId: true,
      currentAgentId: context.namespace.source,
      config: filter
    });
    const candidates = pool.memories
      .filter((memory) => memory.userId === context.userId)
      .map((memory) => packageFromMemory(memory))
      .filter((value): value is DirectSkillPackage => value !== null)
      .slice(0, ROUTE_CANDIDATE_LIMIT);
    if (candidates.length === 0) {
      return { package: null };
    }
    if (!this.deps.skillLlm.isConfigured()) {
      return { package: candidates[0]! };
    }

    try {
      const response = await this.deps.skillLlm.completeJson<{ packageId?: unknown }>([
        {
          role: "system",
          content: [
            "Select exactly one Direct Skill Package for the current task.",
            "Return JSON only: {\"packageId\": string}.",
            "You must choose one listed packageId; never return null or abstain.",
            "A package may be relevant as execution or pre-submit guidance even when the user does not explicitly ask for that verification step.",
            "Judge applicability from the module instruction, scope, and trigger events; do not require title words to appear in the task."
          ].join("\n")
        },
        {
          role: "user",
          content: JSON.stringify({
            task: query,
            toolNames: request.toolNames,
            workspace: request.workspace,
            candidates: candidates.map((candidate) => ({
              packageId: candidate.packageId,
              title: candidate.title,
              summary: candidate.summary,
              modules: candidate.modules.map((module) => ({
                type: module.type,
                instruction: module.instruction,
                scope: module.scope,
                triggerEvents: module.triggerEvents
              }))
            }))
          })
        }
      ], {
        operation: "direct_skill.route_package.v1",
        thinkingMode: "disabled",
        temperature: 0,
        timeoutMs: MODEL_TIMEOUT_MS,
        maxRetries: 1,
        maxTokens: 256,
        jsonMode: true
      });
      return { package: selectRequiredPackage(candidates, response.packageId) };
    } catch {
      return { package: candidates[0]! };
    }
  }

  async selectModules(request: SelectDirectSkillModulesRequest): Promise<SelectDirectSkillModulesResponse> {
    const candidateIds = uniqueNonEmpty(request.candidateModuleIds);
    if (candidateIds.length === 0 || this.deps.config.algorithm.skill.directMode !== "package_v1") {
      return { packageId: request.packageId, selectedModuleIds: [], reason: "no_candidates" };
    }
    const context = this.deps.resolveContext(request);
    const memory = this.deps.repos.memories.get(request.packageId);
    if (!memory || memory.userId !== context.userId) {
      return { packageId: request.packageId, selectedModuleIds: [], reason: "package_not_found" };
    }
    const skillPackage = packageFromMemory(memory);
    if (!skillPackage || skillPackage.packageId !== request.packageId) {
      return { packageId: request.packageId, selectedModuleIds: [], reason: "invalid_package" };
    }
    const moduleById = new Map(skillPackage.modules.map((module) => [module.moduleId, module]));
    if (candidateIds.some((id) => !moduleById.has(id))) {
      return { packageId: request.packageId, selectedModuleIds: [], reason: "invalid_candidates" };
    }
    if (!this.deps.skillLlm.isConfigured()) {
      return { packageId: request.packageId, selectedModuleIds: [], reason: "model_unavailable" };
    }

    const response = await this.deps.skillLlm.completeJson<{
      selectedModuleIds?: unknown;
      reason?: unknown;
    }>([
      {
        role: "system",
        content: [
          "Choose the smallest useful set of Direct Skill Modules for this runtime event.",
          "Return JSON only: {\"selectedModuleIds\": string[], \"reason\": string}.",
          "Use only listed candidate IDs. Select at most one module from each alternativeGroupKey.",
          "Do not invent a strength-priority policy; judge relevance from the task trajectory and event."
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          event: request.event,
          taskMessages: request.taskMessages,
          draftFinalAnswer: request.draftFinalAnswer,
          candidates: candidateIds.map((id) => moduleById.get(id))
        })
      }
    ], {
      operation: "direct_skill.select_modules.v1",
      thinkingMode: "disabled",
      temperature: 0,
      timeoutMs: MODEL_TIMEOUT_MS,
      maxRetries: 1,
      maxTokens: 512,
      jsonMode: true
    });

    const selected = Array.isArray(response.selectedModuleIds)
      ? response.selectedModuleIds.filter((id): id is string => typeof id === "string")
      : [];
    try {
      return {
        packageId: request.packageId,
        selectedModuleIds: validateSelectedModules(selected, candidateIds, moduleById),
        reason: typeof response.reason === "string" ? response.reason : "selected_by_model"
      };
    } catch {
      return { packageId: request.packageId, selectedModuleIds: [], reason: "invalid_model_selection" };
    }
  }
}

export function selectRequiredPackage(
  candidates: readonly DirectSkillPackage[],
  packageId: unknown
): DirectSkillPackage | null {
  if (candidates.length === 0) return null;
  const selectedId = typeof packageId === "string" ? packageId.trim() : "";
  return candidates.find((candidate) => candidate.packageId === selectedId) ?? candidates[0]!;
}

export function validateSelectedModules(
  selectedModuleIds: readonly string[],
  candidateModuleIds: readonly string[],
  moduleById: ReadonlyMap<string, DirectSkillModule>
): string[] {
  const candidates = new Set(candidateModuleIds);
  const selected = uniqueNonEmpty(selectedModuleIds);
  if (selected.some((id) => !candidates.has(id) || !moduleById.has(id))) {
    throw new Error("model selected a Module outside the candidate set");
  }
  const usedAlternativeGroups = new Set<string>();
  for (const id of selected) {
    const group = moduleById.get(id)?.alternativeGroupKey?.trim();
    if (!group) continue;
    if (usedAlternativeGroups.has(group)) {
      throw new Error(`model selected mutually exclusive Modules from ${group}`);
    }
    usedAlternativeGroups.add(group);
  }
  return selected;
}

export function packageFromMemory(memory: {
  id: string;
  tags: string[];
  properties: { internal_info: Record<string, unknown> };
}): DirectSkillPackage | null {
  const internal = memory.properties.internal_info;
  if (internal.runtime_managed !== RUNTIME_MANAGED_MARKER ||
      !memory.tags.some((tag) => tag.trim().toLowerCase() === DIRECT_SKILL_PACKAGE_TAG)) {
    return null;
  }
  const value = internal.direct_skill_package;
  if (!isRecord(value) || value.schemaVersion !== 1 || value.status !== "frozen" ||
      typeof value.packageId !== "string" || value.packageId !== memory.id ||
      typeof value.clusterId !== "string" || typeof value.title !== "string" ||
      typeof value.summary !== "string" || !Array.isArray(value.modules) ||
      !Array.isArray(value.sourceEpisodeIds) || typeof value.createdAt !== "string") {
    return null;
  }
  const modules = value.modules.filter((module): module is Record<string, unknown> & { moduleId: string } =>
    isRecord(module) && typeof module.moduleId === "string" && module.moduleId.trim().length > 0
  );
  if (modules.length !== value.modules.length) return null;
  const skillPackage = value as unknown as DirectSkillPackage;
  const retrievableModules = skillPackage.modules.filter((module) => module.strength !== "L4");
  if (retrievableModules.length === 0) return null;
  return retrievableModules.length === skillPackage.modules.length
    ? skillPackage : { ...skillPackage, modules: retrievableModules };
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
