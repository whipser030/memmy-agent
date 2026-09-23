import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMMY_CONFIG } from "../../../src/config/index.js";
import type { LlmClient } from "../../../src/model/types.js";
import {
  DirectSkillBuildService,
  filterFailureUnsupportedCandidates,
  validateManifest,
  type DirectSkillBuildServiceDeps
} from "../../../src/service/direct-skill/direct-skill-build-service.js";
import type { CandidateModuleRecord, ModuleType } from "../../../src/algorithm/direct-skill/types.js";

describe("DirectSkillBuildService", () => {
  it("normalizes manifest processing order by Episode ID", () => {
    expect(validateManifest(["episode-z", "episode-a", "episode-m"]))
      .toEqual(["episode-a", "episode-m", "episode-z"]);
  });

  it("rejects duplicate Episode IDs before reading storage", async () => {
    let storageReads = 0;
    const deps = {
      repos: {
        runtime: { getEpisode: () => { storageReads += 1; return undefined; } }
      },
      config: DEFAULT_MEMMY_CONFIG,
      skillLlm: fakeLlm(),
      buildMemory: () => { throw new Error("not called"); },
      upsertEvolutionMemory: () => { throw new Error("not called"); },
      enqueueJob: () => { throw new Error("not called"); },
      namespaceIdFromMemory: () => "namespace",
      embedAfterCapture: () => false
    } as unknown as DirectSkillBuildServiceDeps;
    await expect(new DirectSkillBuildService(deps).build({
      episodeIds: ["episode-1", "episode-1"],
      builder: "package_v1"
    })).rejects.toThrow("duplicate IDs");
    expect(storageReads).toBe(0);
  });

  it("rejects a missing manifest Episode before clustering", async () => {
    const deps = {
      repos: { runtime: { getEpisode: () => undefined } },
      config: DEFAULT_MEMMY_CONFIG,
      skillLlm: fakeLlm(),
      buildMemory: () => { throw new Error("not called"); },
      upsertEvolutionMemory: () => { throw new Error("not called"); },
      enqueueJob: () => { throw new Error("not called"); },
      namespaceIdFromMemory: () => "namespace",
      embedAfterCapture: () => false
    } as unknown as DirectSkillBuildServiceDeps;
    await expect(new DirectSkillBuildService(deps).build({
      episodeIds: ["missing"],
      builder: "legacy"
    })).rejects.toThrow("Episode not found");
  });

  it("does not cluster or freeze any Package when source preparation fails", async () => {
    let clusterReads = 0;
    let packageWrites = 0;
    const episode = {
      id: "episode-preparation-fails",
      userId: "user-1",
      sessionId: "session-1",
      status: "closed",
      rTask: 1,
      l1MemoryIds: [],
      rawTurnIds: [],
      meta: {}
    };
    const deps = {
      repos: {
        runtime: {
          getEpisode: () => episode,
          listRawTurnsByEpisode: () => [],
          getSkillClusterForEpisode: () => { clusterReads += 1; return undefined; },
          listSkillClustersByScope: () => { clusterReads += 1; return []; }
        },
        memories: {
          list: () => []
        }
      },
      config: DEFAULT_MEMMY_CONFIG,
      skillLlm: fakeLlm(),
      buildMemory: () => { packageWrites += 1; throw new Error("not called"); },
      upsertEvolutionMemory: () => { packageWrites += 1; throw new Error("not called"); },
      enqueueJob: () => { throw new Error("not called"); },
      namespaceIdFromMemory: () => "namespace",
      embedAfterCapture: () => false
    } as unknown as DirectSkillBuildServiceDeps;
    const service = new DirectSkillBuildService(deps);

    const first = await service.build({
      episodeIds: [episode.id],
      builder: "package_v1"
    });
    const retry = await service.build({
      episodeIds: [episode.id],
      builder: "package_v1"
    });

    expect(first).toMatchObject({ clusterIds: [], builtMemoryIds: [] });
    expect(first.failures).toHaveLength(1);
    expect(retry).toMatchObject({ clusterIds: [], builtMemoryIds: [] });
    expect(retry.failures).toHaveLength(1);
    expect(clusterReads).toBe(0);
    expect(packageWrites).toBe(0);
  });

  it("drops unsupported failure tactics while retaining valid failure and success candidates", () => {
    const candidates = [
      candidate("failure-tactic", "tactic", "failure"),
      candidate("failure-fast", "fast_path", "failure"),
      candidate("failure-repair", "repair", "failure"),
      candidate("success-tactic", "tactic", "success")
    ];

    expect(filterFailureUnsupportedCandidates(candidates).map((item) => item.moduleId))
      .toEqual(["failure-repair", "success-tactic"]);
    expect(filterFailureUnsupportedCandidates(candidates.slice(0, 2))).toEqual([]);
  });

  it("prepares a short trajectory and stores its segmentation without an L1 Trace", async () => {
    const episode = buildEpisode("episode-raw-only");
    const rawTurn = {
      id: "raw-only",
      sessionId: episode.sessionId,
      episodeId: episode.id,
      turnId: "turn-1",
      userId: episode.userId,
      userText: "update the workbook",
      assistantText: "done",
      toolCalls: [],
      toolResults: [],
      sourceMemoryIds: [],
      usage: {},
      messagePayload: {},
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z"
    };
    let savedRawTurn = rawTurn;
    const deps = {
      repos: {
        runtime: {
          getEpisode: () => episode,
          listRawTurnsByEpisode: () => [savedRawTurn],
          getRawTurn: () => savedRawTurn,
          updateRawTurn: (value: typeof rawTurn) => { savedRawTurn = value; return value; }
        },
        memories: { list: () => [] }
      },
      config: DEFAULT_MEMMY_CONFIG,
      skillLlm: fakeLlm(),
      buildMemory: () => { throw new Error("L1 must not be built"); },
      upsertEvolutionMemory: () => { throw new Error("not called"); },
      enqueueJob: () => { throw new Error("not called"); },
      namespaceIdFromMemory: () => "namespace",
      embedAfterCapture: () => false
    } as unknown as DirectSkillBuildServiceDeps;
    const service = new DirectSkillBuildService(deps) as unknown as {
      prepareEpisodeSources(episodeId: string, rTask: number, at: string): Promise<Array<{ rawTurn: { id: string }; spans: unknown[] }>>;
    };

    const sources = await service.prepareEpisodeSources(episode.id, 1, "2026-01-01T00:00:00.000Z");

    expect(sources).toEqual([{ rawTurn: expect.objectContaining({ id: rawTurn.id }), spans: [] }]);
    expect(savedRawTurn.messagePayload).toMatchObject({
      direct_skill_span_segmentation: { mode: "single_goal", spans: [] }
    });
  });

  it("prepares every Cluster before persisting any frozen Package", async () => {
    const episodes = new Map([
      ["episode-a", buildEpisode("episode-a")],
      ["episode-b", buildEpisode("episode-b")]
    ]);
    const deps = buildDeps(episodes);
    const service = new DirectSkillBuildService(deps);
    const internals = service as unknown as {
      prepareEpisodeSources(episodeId: string): Promise<unknown[]>;
      clusterPipeline: { assignEpisodeForDirectBuild(episodeId: string): Promise<string> };
      buildPackageValue(clusterId: string): Promise<unknown>;
      persistPackage(...args: unknown[]): unknown;
    };
    internals.prepareEpisodeSources = async () => [];
    internals.clusterPipeline.assignEpisodeForDirectBuild = async (episodeId) =>
      episodeId === "episode-a" ? "cluster-a" : "cluster-b";
    internals.buildPackageValue = async (clusterId) => {
      if (clusterId === "cluster-b") throw new Error("consolidation failed");
      return { cluster: { id: clusterId }, packageValue: { packageId: "dsp-a" } };
    };
    const persist = vi.fn();
    internals.persistPackage = persist;

    const result = await service.build({
      episodeIds: [...episodes.keys()],
      builder: "package_v1"
    });

    expect(result.builtMemoryIds).toEqual([]);
    expect(result.failures).toEqual([{ clusterId: "cluster-b", reason: "consolidation failed" }]);
    expect(persist).not.toHaveBeenCalled();
  });

  it("reuses an existing Cluster whose complete membership belongs to the retry manifest", async () => {
    const episodes = new Map([
      ["episode-a", buildEpisode("episode-a")],
      ["episode-b", buildEpisode("episode-b")]
    ]);
    const existingCluster = { id: "cluster-existing" };
    const deps = buildDeps(episodes, {
      getSkillClusterForEpisode: () => existingCluster,
      listSkillClusterMembers: () => [
        { clusterId: existingCluster.id, episodeId: "episode-a" },
        { clusterId: existingCluster.id, episodeId: "episode-b" }
      ]
    });
    const service = new DirectSkillBuildService(deps);
    const internals = service as unknown as {
      prepareEpisodeSources(episodeId: string): Promise<unknown[]>;
      clusterPipeline: {
        assignEpisodeForDirectBuild(episodeId: string, at: string, candidates: ReadonlySet<string>): Promise<string>;
      };
      buildPackageValue(clusterId: string): Promise<unknown>;
      persistPackage(...args: unknown[]): { id: string };
    };
    internals.prepareEpisodeSources = async () => [];
    const assign = vi.fn(async (_episodeId: string, _at: string, candidates: ReadonlySet<string>) => {
      expect(candidates.has(existingCluster.id)).toBe(true);
      return existingCluster.id;
    });
    internals.clusterPipeline.assignEpisodeForDirectBuild = assign;
    internals.buildPackageValue = async () => ({
      cluster: existingCluster,
      packageValue: { packageId: "dsp-existing" }
    });
    internals.persistPackage = () => ({ id: "dsp-existing" });

    const result = await service.build({
      episodeIds: [...episodes.keys()],
      builder: "package_v1"
    });

    expect(assign).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      clusterIds: [existingCluster.id],
      builtMemoryIds: ["dsp-existing"],
      failures: []
    });
  });
});

function buildEpisode(id: string) {
  return {
    id,
    userId: "user-1",
    sessionId: "session-1",
    status: "closed",
    rTask: 1,
    l1MemoryIds: [],
    rawTurnIds: [],
    meta: {}
  };
}

function buildDeps(
  episodes: Map<string, ReturnType<typeof buildEpisode>>,
  runtimeOverrides: Record<string, unknown> = {}
): DirectSkillBuildServiceDeps {
  return {
    repos: {
      runtime: {
        getEpisode: (episodeId: string) => episodes.get(episodeId),
        listRawTurnsByEpisode: () => [],
        getSkillClusterForEpisode: () => undefined,
        listSkillClusterMembers: () => [],
        ...runtimeOverrides
      },
      memories: { list: () => [] },
      transaction: <T>(run: () => T) => run()
    },
    config: DEFAULT_MEMMY_CONFIG,
    skillLlm: fakeLlm(),
    buildMemory: () => { throw new Error("not called"); },
    upsertEvolutionMemory: () => { throw new Error("not called"); },
    enqueueJob: () => { throw new Error("not called"); },
    namespaceIdFromMemory: () => "namespace",
    embedAfterCapture: () => false
  } as unknown as DirectSkillBuildServiceDeps;
}

function candidate(
  moduleId: string,
  type: ModuleType,
  outcome: "success" | "failure" | "mixed"
): CandidateModuleRecord {
  return {
    moduleId,
    semanticKey: moduleId.replace(/-/g, "_"),
    type,
    instruction: moduleId,
    scope: { tasks: [], tools: [], resources: [], operations: [] },
    triggerEvents: ["turn_start"],
    requiredEvidence: [],
    evidenceRefs: [`turn-${moduleId}`],
    authority: "task_evidence",
    evidencePattern: "single_observation",
    material: {
      materialId: `material-${moduleId}`,
      rawTurnId: `turn-${moduleId}`,
      episodeId: "episode-1",
      subgoal: moduleId,
      outcome,
      observation: moduleId,
      proposedAction: moduleId,
      scopeClues: [],
      evidenceRefs: [`turn-${moduleId}`]
    }
  };
}

function fakeLlm(): LlmClient {
  return {
    config: { ...DEFAULT_MEMMY_CONFIG.evolution, provider: "host", endpoint: "http://test", model: "test" },
    isConfigured: () => true,
    complete: async () => "{}",
    completeJson: async <T extends Record<string, unknown>>() => ({} as T),
    status: () => ({ provider: "host", model: "test", configured: true, remote: false })
  };
}
