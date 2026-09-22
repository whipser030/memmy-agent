import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseEpisodeManifest, runCommand } from "../src/cli/commands.js";

describe("Direct Skill CLI manifest", () => {
  it("accepts a non-empty unique Episode ID array", () => {
    expect(parseEpisodeManifest('["episode_1", "episode_2"]')).toEqual(["episode_1", "episode_2"]);
  });

  it("rejects malformed, empty, non-string, and duplicate manifests", () => {
    expect(() => parseEpisodeManifest("{")).toThrow(/valid JSON/);
    expect(() => parseEpisodeManifest("[]")).toThrow(/non-empty/);
    expect(() => parseEpisodeManifest('["episode_1", 2]')).toThrow(/strings/);
    expect(() => parseEpisodeManifest('["episode_1", "episode_1"]')).toThrow(/duplicate/);
  });

  it("posts the validated manifest and surfaces partial build failures", async () => {
    const root = mkdtempSync(join(tmpdir(), "direct-skill-cli-"));
    try {
      const manifest = join(root, "episodes.json");
      writeFileSync(manifest, '["episode_1"]');
      const requests: Array<{ url: string; body: unknown }> = [];
      const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined
        });
        return new Response(JSON.stringify({
          episodeCount: 1,
          clusterIds: [],
          builtMemoryIds: [],
          failures: []
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof globalThis.fetch;

      await runCommand({
        argv: [
          "direct-skill", "build",
          "--episode-manifest", manifest,
          "--builder", "package_v1",
          "--url", "http://memory.test"
        ],
        fetch
      });

      expect(new URL(requests[0]!.url).pathname).toBe("/api/v1/direct-skills/build");
      expect(requests[0]!.body).toEqual({ episodeIds: ["episode_1"], builder: "package_v1" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
