import { ModuleExtractor } from "../../algorithm/direct-skill/module-extractor.js";
import { PackageBuilder } from "../../algorithm/direct-skill/package-builder.js";
import type {
  CandidateModuleRecord,
  DirectSkillExtractionSource,
  DirectSkillPackage
} from "../../algorithm/direct-skill/types.js";
import { classifySkillOutcome, isEvalSplitTest } from "../../algorithm/trace-direct-skill.js";
import type { MemmyConfig } from "../../config/index.js";
import { createMemoryLogger, memoryErrorFields } from "../../logging/logger.js";
import type { LlmClient } from "../../model/types.js";
import {
  type EpisodeRecord,
  kindFromMemory,
  type EvolutionJobRecord,
  type RawTurnRecord,
  type Repositories,
  type SkillClusterRecord
} from "../../storage/repositories.js";
import type { MemoryRow } from "../../types.js";
import { isRecord } from "../../utils/json.js";
import { newId, stableStringify } from "../../utils/id.js";
import { nowIso } from "../../utils/time.js";
import type { EnqueueJobInput } from "../worker/job-handlers.js";
import {
  BigTurnSpanPipeline,
  type DirectSkillTrajectorySpan
} from "../evolution/big-turn-span-pipeline.js";
import { SkillClusterPipeline } from "../evolution/skill-cluster-pipeline.js";

const directSkillBuildLogger = createMemoryLogger("direct-skill-build");

export interface DirectSkillBuildRequest {
  episodeIds: string[];
  builder: "legacy" | "package_v1";
  clusterConcurrency?: number;
  resumeExistingPackages?: boolean;
  clusterOnly?: boolean;
}

export interface DirectSkillBuildResult {
  episodeCount: number;
  clusterIds: string[];
  builtMemoryIds: string[];
  failures: Array<{ clusterId?: string; episodeId?: string; reason: string }>;
}

export interface DirectSkillBuildServiceDeps {
  repos: Repositories;
  config: MemmyConfig;
  skillLlm: LlmClient;
  buildMemory(input: Record<string, unknown>): MemoryRow;
  upsertEvolutionMemory(memory: MemoryRow): { memory: MemoryRow; created: boolean; previous?: MemoryRow };
  enqueueJob(input: EnqueueJobInput): EvolutionJobRecord;
  namespaceIdFromMemory(memory: MemoryRow): string;
  queryVector?(query: string): Promise<number[] | undefined>;
  embedAfterCapture(): boolean;
  nowIso?(): string;
}

interface TurnBuildSource {
  rawTurn: RawTurnRecord;
  spans: DirectSkillTrajectorySpan[];
}

interface PreparedPackage {
  cluster: SkillClusterRecord;
  packageValue: DirectSkillPackage;
}

export class DirectSkillBuildService {
  private readonly spanPipeline: BigTurnSpanPipeline;
  private readonly clusterPipeline: SkillClusterPipeline;
  private readonly extractor: ModuleExtractor;
  private readonly packageBuilder: PackageBuilder;

  constructor(private readonly deps: DirectSkillBuildServiceDeps) {
    this.spanPipeline = new BigTurnSpanPipeline({
      repos: deps.repos,
      llm: deps.skillLlm,
      buildMemory: deps.buildMemory,
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      embedAfterCapture: deps.embedAfterCapture
    });
    this.clusterPipeline = new SkillClusterPipeline({
      repos: deps.repos,
      config: deps.config,
      skillLlm: deps.skillLlm,
      buildMemory: deps.buildMemory,
      upsertEvolutionMemory: deps.upsertEvolutionMemory,
      enqueueJob: deps.enqueueJob,
      namespaceIdFromMemory: deps.namespaceIdFromMemory,
      queryVector: deps.queryVector
    });
    this.extractor = new ModuleExtractor(deps.skillLlm);
    this.packageBuilder = new PackageBuilder(deps.skillLlm);
  }

  async build(request: DirectSkillBuildRequest): Promise<DirectSkillBuildResult> {
    const episodeIds = validateManifest(request.episodeIds);
    if (request.builder !== "legacy" && request.builder !== "package_v1") {
      throw new Error(`unsupported direct-skill builder: ${String(request.builder)}`);
    }
    if (request.clusterOnly && request.builder !== "package_v1") {
      throw new Error("direct-skill clusterOnly requires package_v1 builder");
    }
    const episodes = episodeIds.map((episodeId) => {
      const episode = this.deps.repos.runtime.getEpisode(episodeId);
      if (!episode) throw new Error(`direct-skill Episode not found: ${episodeId}`);
      if (isEvalSplitTest(episode.meta)) throw new Error(`direct-skill manifest contains test Episode: ${episodeId}`);
      if (typeof episode.rTask !== "number") throw new Error(`direct-skill Episode is not scored: ${episodeId}`);
      return episode;
    });
    const clusterConcurrency = validateClusterConcurrency(request.clusterConcurrency);
    const existingPackages = request.builder === "package_v1"
      ? this.existingPackagesForEpisodes(episodeIds)
      : [];
    if (existingPackages.length > 0 && !request.resumeExistingPackages) {
      throw new Error(`direct-skill manifest overlaps frozen Package: ${existingPackages[0]!.id}`);
    }
    const at = this.deps.nowIso?.() ?? nowIso();
    const failures: DirectSkillBuildResult["failures"] = [];
    const sourceByEpisode = new Map<string, TurnBuildSource[]>();

    if (request.builder === "package_v1" && !request.clusterOnly) {
      for (const episode of episodes) {
        try {
          sourceByEpisode.set(episode.id, await this.prepareEpisodeSources(episode.id, episode.rTask!, at));
        } catch (error) {
          logDirectSkillFailure("direct_skill.source_preparation", error, { episodeId: episode.id });
          failures.push({ episodeId: episode.id, reason: errorMessage(error) });
        }
      }
      if (failures.length > 0) {
        return {
          episodeCount: episodes.length,
          clusterIds: [],
          builtMemoryIds: [],
          failures
        };
      }
    }

    const clusterIds = request.builder === "package_v1"
      ? this.reusableManifestClusterIds(episodeIds)
      : new Set<string>();
    const episodeIdsByCluster = new Map<string, string[]>();
    for (const episode of episodes) {
      try {
        const assignedCluster = request.builder === "package_v1"
          ? this.deps.repos.runtime.getSkillClusterForEpisode(episode.id)
          : undefined;
        const clusterId = assignedCluster && clusterIds.has(assignedCluster.id)
          ? assignedCluster.id
          : await this.clusterPipeline.assignEpisodeForDirectBuild(episode.id, at, clusterIds);
        clusterIds.add(clusterId);
        episodeIdsByCluster.set(clusterId, [...(episodeIdsByCluster.get(clusterId) ?? []), episode.id]);
      } catch (error) {
        logDirectSkillFailure("direct_skill.cluster_assignment", error, { episodeId: episode.id });
        failures.push({ episodeId: episode.id, reason: errorMessage(error) });
      }
    }
    if (request.builder === "package_v1" && failures.length > 0) {
      return {
        episodeCount: episodes.length,
        clusterIds: [...clusterIds].sort(),
        builtMemoryIds: [],
        failures
      };
    }
    if (request.clusterOnly) {
      return {
        episodeCount: episodes.length,
        clusterIds: [...clusterIds].sort(),
        builtMemoryIds: [],
        failures: []
      };
    }

    const sortedClusterIds = [...clusterIds].sort();
    const builtMemoryIds: string[] = [];
    if (request.builder === "legacy") {
      for (const clusterId of sortedClusterIds) {
        try {
          const memoryId = await this.clusterPipeline.buildLegacyClusterForDirectBuild(clusterId, at);
          if (memoryId) builtMemoryIds.push(memoryId);
        } catch (error) {
          logDirectSkillFailure("direct_skill.legacy_package_build", error, { clusterId });
          failures.push({ clusterId, reason: errorMessage(error) });
        }
      }
    } else {
      this.assertResumePackagesCompatible(existingPackages, episodeIdsByCluster);
      const existingByCluster = new Map(existingPackages.map((memory) => [packageClusterId(memory), memory]));
      const results = await mapWithConcurrency(sortedClusterIds, clusterConcurrency, async (clusterId) => {
        try {
          const existing = existingByCluster.get(clusterId);
          if (existing) return { clusterId, memoryId: existing.id };
          const prepared = await this.buildPackageValue(
            clusterId,
            episodeIdsByCluster.get(clusterId) ?? [],
            sourceByEpisode,
            at
          );
          const persisted = this.deps.repos.transaction(() =>
            this.persistPackage(prepared.cluster, prepared.packageValue, at)
          );
          return { clusterId, memoryId: persisted.id };
        } catch (error) {
          logDirectSkillFailure("direct_skill.package_build", error, { clusterId });
          return { clusterId, reason: errorMessage(error) };
        }
      });
      for (const result of results) {
        if (typeof result.memoryId === "string") builtMemoryIds.push(result.memoryId);
        else failures.push({ clusterId: result.clusterId, reason: result.reason });
      }
    }

    return {
      episodeCount: episodes.length,
      clusterIds: [...clusterIds].sort(),
      builtMemoryIds,
      failures
    };
  }

  private async prepareEpisodeSources(episodeId: string, rTask: number, at: string): Promise<TurnBuildSource[]> {
    const rawTurns = this.deps.repos.runtime.listRawTurnsByEpisode(episodeId, 1000);
    if (rawTurns.length === 0) throw new Error(`direct-skill Episode has no Raw Turns: ${episodeId}`);
    const sources: TurnBuildSource[] = [];
    for (const rawTurn of rawTurns) {
      const segmentation = await this.spanPipeline.segmentTrajectoryForDirectSkill({
        rawTurnId: rawTurn.id,
        episodeId,
        rTask,
        at
      });
      sources.push({
        rawTurn,
        spans: segmentation.spans
      });
    }
    return sources;
  }

  private async buildPackageValue(
    clusterId: string,
    manifestEpisodeIds: string[],
    sourceByEpisode: Map<string, TurnBuildSource[]>,
    at: string
  ): Promise<PreparedPackage> {
    const cluster = this.deps.repos.runtime.getSkillCluster(clusterId);
    if (!cluster) throw new Error(`direct-skill Cluster not found: ${clusterId}`);
    if (this.existingPackageForCluster(clusterId)) {
      throw new Error(`direct-skill frozen Package already exists for Cluster ${clusterId}`);
    }
    const episodeIds = unique(manifestEpisodeIds);
    if (episodeIds.length === 0) throw new Error(`direct-skill Cluster has no manifest Episodes: ${clusterId}`);
    const candidates: CandidateModuleRecord[] = [];
    for (const episodeId of episodeIds) {
      const episode = this.deps.repos.runtime.getEpisode(episodeId);
      if (!episode || typeof episode.rTask !== "number") continue;
      const outcome = classifySkillOutcome(episode.rTask, {
        success: this.deps.config.algorithm.skill.outcomeRTaskSuccessThreshold,
        failure: this.deps.config.algorithm.skill.outcomeRTaskFailureThreshold
      });
      const normalizedOutcome = outcome === "unknown" ? "mixed" : outcome;
      for (const source of sourceByEpisode.get(episodeId) ?? []) {
        if (source.spans.length === 0) {
          try {
            const result = await this.extractor.extractFromTurn(turnExtractionSource(source.rawTurn, episode, normalizedOutcome));
            if (result.decision === "accept") candidates.push(...result.modules.map((item) => item.candidateModule));
          } catch (error) {
            throw new Error(
              `direct-skill Module extraction failed: episodeId=${episodeId}, sourceType=turn, ` +
              `sourceId=${source.rawTurn.id}, reason=${errorMessage(error)}`
            );
          }
          continue;
        }
        for (const span of source.spans) {
          try {
            const result = await this.extractor.extractFromSpan(spanExtractionSource(span, source.rawTurn, episode, normalizedOutcome));
            if (result.decision === "accept") candidates.push(...result.modules.map((item) => item.candidateModule));
          } catch (error) {
            throw new Error(
              `direct-skill Module extraction failed: episodeId=${episodeId}, sourceType=span, ` +
              `sourceId=${span.spanId}, reason=${errorMessage(error)}`
            );
          }
        }
      }
    }
    const packageId = newId("dsp");
    let packageValue: DirectSkillPackage;
    try {
      packageValue = await this.packageBuilder.build({
        packageId,
        clusterId,
        candidates: filterFailureUnsupportedCandidates(candidates),
        sourceEpisodeIds: episodeIds,
        createdAt: at
      });
    } catch (error) {
      throw new Error(
        `direct-skill Package assembly failed: clusterId=${clusterId}, reason=${errorMessage(error)}`
      );
    }
    return { cluster, packageValue };
  }

  private persistPackage(cluster: SkillClusterRecord, packageValue: DirectSkillPackage, at: string): MemoryRow {
    const memoryValue = renderPackageSummary(packageValue);
    const memory = this.deps.buildMemory({
      id: packageValue.packageId,
      userId: cluster.userId,
      projectId: cluster.projectId,
      layer: "Skill",
      kind: "skill",
      lifecycleStatus: "active",
      memoryType: "SkillMemory",
      key: `skill:direct-package:${cluster.id}`,
      value: memoryValue,
      tags: ["skill", "direct-skill-package"],
      info: {
        name: packageValue.title,
        status: "active",
        cluster_id: cluster.id,
        source_episode_ids: packageValue.sourceEpisodeIds
      },
      internal: {
        source: "direct_skill.package_v1",
        plugin_algorithm: "direct_skill.package_v1",
        runtime_managed: "direct_skill_v1",
        generated_by_memory_base: true,
        direct_skill_package: packageValue
      },
      createdAt: at
    });
    const upserted = this.deps.upsertEvolutionMemory(memory);
    if (!upserted.created) throw new Error(`direct-skill Package ID already exists: ${packageValue.packageId}`);
    this.deps.repos.runtime.appendChange({
      memoryId: upserted.memory.id,
      namespaceId: this.deps.namespaceIdFromMemory(upserted.memory),
      kind: kindFromMemory(upserted.memory),
      op: "created",
      entityId: upserted.memory.id,
      userId: upserted.memory.userId,
      changeType: "direct_skill_package_created",
      after: upserted.memory,
      source: "direct_skill.package_v1",
      createdAt: at
    });
    for (const episodeId of packageValue.sourceEpisodeIds) {
      this.deps.repos.runtime.appendEpisodeDerivedMemory(episodeId, "Skill", upserted.memory.id, at);
    }
    if (this.deps.embedAfterCapture()) {
      this.deps.enqueueJob({
        jobType: "embedding",
        userId: upserted.memory.userId,
        episodeId: packageValue.sourceEpisodeIds[0],
        targetMemoryId: upserted.memory.id,
        payload: { reason: "direct_skill.package_created", clusterId: cluster.id },
        createdAt: at
      });
    }
    return upserted.memory;
  }

  private existingPackageForCluster(clusterId: string): MemoryRow | undefined {
    return this.deps.repos.memories
      .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, 10_000)
      .find((memory) => memory.tags.includes("direct-skill-package") &&
        memory.properties.internal_info.runtime_managed === "direct_skill_v1" &&
        isRecord(memory.properties.internal_info.direct_skill_package) &&
        memory.properties.internal_info.direct_skill_package.clusterId === clusterId);
  }

  private existingPackagesForEpisodes(episodeIds: string[]): MemoryRow[] {
    const requested = new Set(episodeIds);
    return this.deps.repos.memories
      .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, 10_000)
      .filter((memory) => {
        const value = memory.properties.internal_info.direct_skill_package;
        return memory.tags.includes("direct-skill-package") &&
          memory.properties.internal_info.runtime_managed === "direct_skill_v1" &&
          isRecord(value) &&
          Array.isArray(value.sourceEpisodeIds) &&
          value.sourceEpisodeIds.some((episodeId) => typeof episodeId === "string" && requested.has(episodeId));
      });
  }

  private assertResumePackagesCompatible(
    existingPackages: MemoryRow[],
    episodeIdsByCluster: Map<string, string[]>
  ): void {
    for (const memory of existingPackages) {
      const clusterId = packageClusterId(memory);
      const packageValue = memory.properties.internal_info.direct_skill_package;
      const storedEpisodeIds = isRecord(packageValue) && Array.isArray(packageValue.sourceEpisodeIds)
        ? packageValue.sourceEpisodeIds.filter((value): value is string => typeof value === "string")
        : [];
      const requestedEpisodeIds = episodeIdsByCluster.get(clusterId) ?? [];
      if (!sameStringSet(storedEpisodeIds, requestedEpisodeIds)) {
        throw new Error(`direct-skill resume does not match frozen Package: ${memory.id}`);
      }
    }
  }

  private reusableManifestClusterIds(episodeIds: string[]): Set<string> {
    const manifest = new Set(episodeIds);
    const reusable = new Set<string>();
    for (const episodeId of episodeIds) {
      const cluster = this.deps.repos.runtime.getSkillClusterForEpisode(episodeId);
      if (!cluster || reusable.has(cluster.id)) continue;
      const members = this.deps.repos.runtime.listSkillClusterMembers(cluster.id);
      if (members.length > 0 && members.every((member) => manifest.has(member.episodeId))) {
        reusable.add(cluster.id);
      }
    }
    return reusable;
  }
}

export function validateManifest(episodeIds: string[]): string[] {
  if (!Array.isArray(episodeIds) || episodeIds.length === 0) {
    throw new Error("direct-skill episode manifest must be a non-empty array");
  }
  if (episodeIds.some((id) => typeof id !== "string" || !id.trim())) {
    throw new Error("direct-skill episode manifest contains an invalid ID");
  }
  const normalized = episodeIds.map((id) => id.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("direct-skill episode manifest contains duplicate IDs");
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function turnExtractionSource(
  rawTurn: RawTurnRecord,
  episode: EpisodeRecord,
  outcome: DirectSkillExtractionSource["outcome"]
): DirectSkillExtractionSource {
  return {
    sourceType: "turn",
    sourceId: rawTurn.id,
    episodeId: rawTurn.episodeId,
    outcome,
    userRequest: rawTurn.userText ?? "",
    assistantFinalAnswer: rawTurn.assistantText ?? "",
    subgoal: rawTurn.userText ?? "coherent task turn",
    summary: rawTurn.reasoningSummary ?? rawTurn.assistantText ?? "",
    toolSteps: rawTurn.toolCalls.map((call, index) => ({
      evidenceRef: `${rawTurn.id}:tool:${index}`,
      call,
      result: rawTurn.toolResults[index] ?? null
    })),
    evaluation: {
      rTask: episode.rTask!,
      detail: episode.rewardDetail
    }
  };
}

function spanExtractionSource(
  span: DirectSkillTrajectorySpan,
  rawTurn: RawTurnRecord,
  episode: EpisodeRecord,
  outcome: DirectSkillExtractionSource["outcome"]
): DirectSkillExtractionSource {
  if (span.start < 0 || span.end < span.start || span.end >= rawTurn.toolCalls.length) {
    throw new Error(`direct-skill Span tool range is invalid: ${span.spanId}`);
  }
  return {
    sourceType: "span",
    sourceId: span.spanId,
    episodeId: rawTurn.episodeId,
    outcome,
    userRequest: rawTurn.userText ?? "",
    assistantFinalAnswer: rawTurn.assistantText ?? "",
    subgoal: span.spanGoal,
    summary: span.summary,
    toolSteps: rawTurn.toolCalls.slice(span.start, span.end + 1).map((call, index) => ({
      evidenceRef: `${span.spanId}:tool:${index}`,
      call,
      result: rawTurn.toolResults[span.start + index] ?? null
    })),
    evaluation: {
      rTask: episode.rTask!,
      detail: episode.rewardDetail
    }
  };
}

export function filterFailureUnsupportedCandidates(
  candidates: CandidateModuleRecord[]
): CandidateModuleRecord[] {
  return candidates.filter((candidate) => !(
    candidate.material.outcome === "failure" &&
    (candidate.type === "tactic" || candidate.type === "fast_path")
  ));
}

function renderPackageSummary(packageValue: DirectSkillPackage): string {
  const tools = unique(packageValue.modules.flatMap((module) => module.scope.tools));
  const resources = unique(packageValue.modules.flatMap((module) => module.scope.resources));
  return [
    `# ${packageValue.title}`,
    packageValue.summary,
    tools.length ? `Tools: ${tools.join(", ")}` : "",
    resources.length ? `Resources: ${resources.join(", ")}` : "",
    "Modules:",
    ...packageValue.modules.map((module) => `- [${module.strength}] ${module.semanticKey}: ${module.instruction}`)
  ].filter(Boolean).join("\n");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : stableStringify(error);
}

function logDirectSkillFailure(
  stage: string,
  error: unknown,
  context: { clusterId?: string; episodeId?: string }
): void {
  directSkillBuildLogger.error("build.failed", {
    stage,
    ...context,
    ...memoryErrorFields(error)
  });
}

function validateClusterConcurrency(value: number | undefined): number {
  const normalized = value ?? 1;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 32) {
    throw new Error("direct-skill clusterConcurrency must be an integer from 1 to 32");
  }
  return normalized;
}

function packageClusterId(memory: MemoryRow): string {
  const packageValue = memory.properties.internal_info.direct_skill_package;
  if (!isRecord(packageValue) || typeof packageValue.clusterId !== "string") {
    throw new Error(`direct-skill Package has no Cluster ID: ${memory.id}`);
  }
  return packageValue.clusterId;
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  run: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await run(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
