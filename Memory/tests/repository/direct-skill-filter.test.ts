import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/index.js";
import { Repositories } from "../../src/storage/repositories.js";
import type { MemoryRow } from "../../src/types.js";

describe("Direct Skill repository filter", () => {
  it("excludes Package tags before retrieval candidates are loaded", () => {
    const root = mkdtempSync(join(tmpdir(), "direct-skill-filter-"));
    try {
      const db = new MemoryDb({ path: join(root, "memory.sqlite") });
      const repos = new Repositories(db.db);
      repos.memories.insert(skill("legacy_skill", ["skill", "direct-trace"]));
      repos.memories.insert(skill("package_skill", ["skill", "direct-skill-package"]));

      const filter = {
        memoryLayer: "Skill" as const,
        excludedTags: ["DIRECT-SKILL-PACKAGE"]
      };
      expect(repos.memories.count(filter)).toBe(1);
      expect(repos.memories.list(filter, 10).map((memory) => memory.id)).toEqual(["legacy_skill"]);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function skill(id: string, tags: string[]): MemoryRow {
  const at = "2026-09-22T00:00:00.000Z";
  return {
    id,
    timeline: at,
    userId: "direct-skill-user",
    memoryType: "SkillMemory",
    status: "activated",
    visibility: "private",
    memoryKey: `skill:${id}`,
    memoryValue: id,
    tags,
    info: {},
    properties: {
      internal_info: { memory_layer: "Skill", memory_kind: "skill" }
    },
    memoryLayer: "Skill",
    version: 1,
    createdAt: at,
    updatedAt: at,
    deletedAt: null
  };
}
