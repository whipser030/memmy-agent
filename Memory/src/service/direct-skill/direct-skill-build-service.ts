import { ModuleExtractor } from "../../algorithm/direct-skill/module-extractor.js";
import { PackageBuilder } from "../../algorithm/direct-skill/package-builder.js";
import type {
  CandidateModuleRecord,
  DirectSkillExtractionSource,
  DirectSkillPackage
} from "../../algorithm/direct-skill/types.js";
import { classifySkillOutcome, isEvalSplitTest } from "../../algorithm/trace-direct-skill.js";
import type { MemmyConfig } from "../../config/index.js";
import type { LlmClient } from "../../model/types.js";
import {
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
import { BigTurnSpanPipeline, SPAN_BIG_TURN_MIN_TOOL_CALLS } from "../evolution/big-turn-span-pipeline.js";
import { SkillClusterPipeline } from "../evolution/skill-cluster-pipeline.js";

export interface DirectSkillBuildRequest {
  episodeIds: string[];
  builder: "legacy" | "package_v1";
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
  sourceTrace: MemoryRow;
  spanIds: string[];
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
    const episodes = episodeIds.map((episodeId) => {
      const episode = this.deps.repos.runtime.getEpisode(episodeId);
      if (!episode) throw new Error(`direct-skill Episode not found: ${episodeId}`);
      if (isEvalSplitTest(episode.meta)) throw new Error(`direct-skill manifest contains test Episode: ${episodeId}`);
      if (typeof episode.rTask !== "number") throw new Error(`direct-skill Episode is not scored: ${episodeId}`);
      return episode;
    });
    if (request.builder === "package_v1") this.assertNoFrozenPackageForEpisodes(episodeIds);
    const at = this.deps.nowIso?.() ?? nowIso();
    const failures: DirectSkillBuildResult["failures"] = [];
    const sourceByEpisode = new Map<string, TurnBuildSource[]>();

    if (request.builder === "package_v1") {
      for (const episode of episodes) {
        try {
          sourceByEpisode.set(episode.id, await this.prepareEpisodeSources(episode.id, episode.rTask!, at));
        } catch (error) {
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
        const clusterId = await this.clusterPipeline.assignEpisodeForDirectBuild(episode.id, at, clusterIds);
        clusterIds.add(clusterId);
        episodeIdsByCluster.set(clusterId, [...(episodeIdsByCluster.get(clusterId) ?? []), episode.id]);
      } catch (error) {
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

    const builtMemoryIds: string[] = [];
    const preparedPackages: PreparedPackage[] = [];
    for (const clusterId of [...clusterIds].sort()) {
      try {
        if (request.builder === "legacy") {
          const memoryId = await this.clusterPipeline.buildLegacyClusterForDirectBuild(clusterId, at);
          if (memoryId) builtMemoryIds.push(memoryId);
          continue;
        }
        preparedPackages.push(await this.buildPackageValue(
          clusterId,
          episodeIdsByCluster.get(clusterId) ?? [],
          sourceByEpisode,
          at
        ));
      } catch (error) {
        failures.push({ clusterId, reason: errorMessage(error) });
      }
    }

    if (request.builder === "package_v1" && failures.length === 0) {
      const persisted = this.deps.repos.transaction(() =>
        preparedPackages.map(({ cluster, packageValue }) =>
          this.persistPackage(cluster, packageValue, at)
        )
      );
      builtMemoryIds.push(...persisted.map((memory) => memory.id));
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
      const sourceTrace = this.sourceTraceForRawTurn(episodeId, rawTurn.id);
      if (!sourceTrace) throw new Error(`direct-skill Trace not found for Raw Turn: ${rawTurn.id}`);
      if (rawTurn.toolCalls.length < SPAN_BIG_TURN_MIN_TOOL_CALLS) {
        sources.push({ rawTurn, sourceTrace, spanIds: [] });
        continue;
      }
      const segmentation = await this.spanPipeline.segmentForDirectSkill({
        sourceTraceId: sourceTrace.id,
        rawTurnId: rawTurn.id,
        episodeId,
        rTask,
        at
      });
      sources.push({
        rawTurn,
        sourceTrace,
        spanIds: segmentation.mode === "multi_goal" ? segmentation.spanIds : []
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
        if (source.spanIds.length === 0) {
          const result = await this.extractor.extractFromTurn(turnExtractionSource(source.rawTurn, normalizedOutcome));
          if (result.decision === "accept") candidates.push(result.candidateModule);
          continue;
        }
        for (const spanId of source.spanIds) {
          const span = this.deps.repos.memories.get(spanId);
          if (!span) throw new Error(`direct-skill Span not found: ${spanId}`);
          const result = await this.extractor.extractFromSpan(spanExtractionSource(span, source.rawTurn, normalizedOutcome));
          if (result.decision === "accept") candidates.push(result.candidateModule);
        }
      }
    }
    const packageId = newId("dsp");
    const packageValue = await this.packageBuilder.build({
      packageId,
      clusterId,
      candidates: filterFailureUnsupportedCandidates(candidates),
      sourceEpisodeIds: episodeIds,
      createdAt: at
    });
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

  private sourceTraceForRawTurn(episodeId: string, rawTurnId: string): MemoryRow | undefined {
    const episode = this.deps.repos.runtime.getEpisode(episodeId);
    return episode?.l1MemoryIds
      .map((id) => this.deps.repos.memories.get(id))
      .find((memory): memory is MemoryRow => Boolean(memory && rawTurnIdFromMemory(memory) === rawTurnId));
  }

  private existingPackageForCluster(clusterId: string): MemoryRow | undefined {
    return this.deps.repos.memories
      .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, 10_000)
      .find((memory) => memory.tags.includes("direct-skill-package") &&
        memory.properties.internal_info.runtime_managed === "direct_skill_v1" &&
        isRecord(memory.properties.internal_info.direct_skill_package) &&
        memory.properties.internal_info.direct_skill_package.clusterId === clusterId);
  }

  private assertNoFrozenPackageForEpisodes(episodeIds: string[]): void {
    const requested = new Set(episodeIds);
    const existing = this.deps.repos.memories
      .list({ memoryLayer: "Skill", status: ["activated", "resolving"] }, 10_000)
      .find((memory) => {
        const value = memory.properties.internal_info.direct_skill_package;
        return memory.tags.includes("direct-skill-package") &&
          memory.properties.internal_info.runtime_managed === "direct_skill_v1" &&
          isRecord(value) &&
          Array.isArray(value.sourceEpisodeIds) &&
          value.sourceEpisodeIds.some((episodeId) => typeof episodeId === "string" && requested.has(episodeId));
      });
    if (existing) {
      throw new Error(`direct-skill manifest overlaps frozen Package: ${existing.id}`);
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
    toolCalls: rawTurn.toolCalls
  };
}

function spanExtractionSource(
  span: MemoryRow,
  rawTurn: RawTurnRecord,
  outcome: DirectSkillExtractionSource["outcome"]
): DirectSkillExtractionSource {
  const metadata = span.properties.internal_info.span;
  if (!isRecord(metadata)) throw new Error(`direct-skill Span metadata is invalid: ${span.id}`);
  const start = integer(metadata.tool_call_start);
  const end = integer(metadata.tool_call_end);
  if (start === undefined || end === undefined || start < 0 || end < start || end >= rawTurn.toolCalls.length) {
    throw new Error(`direct-skill Span tool range is invalid: ${span.id}`);
  }
  return {
    sourceType: "span",
    sourceId: span.id,
    episodeId: rawTurn.episodeId,
    outcome,
    userRequest: rawTurn.userText ?? "",
    assistantFinalAnswer: rawTurn.assistantText ?? "",
    subgoal: text(metadata.span_goal) ?? span.memoryKey ?? "subgoal",
    summary: text(metadata.summary) ?? span.memoryValue,
    toolCalls: rawTurn.toolCalls.slice(start, end + 1)
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

function rawTurnIdFromMemory(memory: MemoryRow): string | undefined {
  const internal = memory.properties.internal_info;
  const direct = internal.source_raw_turn_id ?? internal.raw_turn_id;
  if (typeof direct === "string" && direct) return direct;
  const trace = internal.trace;
  return isRecord(trace) && typeof trace.raw_turn_id === "string" ? trace.raw_turn_id : undefined;
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

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : stableStringify(error);
}
