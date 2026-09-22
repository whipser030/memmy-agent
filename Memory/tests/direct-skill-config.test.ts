import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMemmyConfig } from "../src/config/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configFor(skill: string): string {
  const root = mkdtempSync(join(tmpdir(), "direct-skill-config-"));
  roots.push(root);
  const file = join(root, "config.yaml");
  writeFileSync(file, `memmyMemory:\n  algorithm:\n    skill:\n${skill}\n`);
  return file;
}

describe("Direct Skill mode config", () => {
  it("uses explicit directMode when present", () => {
    expect(loadMemmyConfig(configFor("      directMode: package_v1")).config.algorithm.skill.directMode)
      .toBe("package_v1");
  });

  it("maps legacy directFromTrace when directMode is absent", () => {
    expect(loadMemmyConfig(configFor("      directFromTrace: true")).config.algorithm.skill.directMode)
      .toBe("legacy");
    expect(loadMemmyConfig(configFor("      directFromTrace: false")).config.algorithm.skill.directMode)
      .toBe("off");
  });
});
