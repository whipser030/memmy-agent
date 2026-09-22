import type { DirectSkillModule, DirectSkillPackage, RuntimeEventBatch } from "./types.js";

export function renderDirectSkillSop(
  skillPackage: DirectSkillPackage,
  modules: DirectSkillModule[],
  event: RuntimeEventBatch,
): string {
  const title = skillPackage.title?.trim() || "Relevant operating guidance";
  const steps = modules.flatMap((module, index) => {
    const strength = module.strength ?? "L1";
    const lines = [`${index + 1}. [${strength}] ${module.instruction.trim()}`];
    if (strength === "L3" || strength === "L4") {
      if (module.completionRule) lines.push(`   Completion: ${renderValue(module.completionRule)}`);
      if (module.requiredEvidence?.length) lines.push(`   Evidence: ${module.requiredEvidence.map(renderValue).join("; ")}`);
      if (module.recovery?.trim()) lines.push(`   Recovery: ${module.recovery.trim()}`);
    }
    return lines;
  });
  return [
    `<direct_skill_sop package_id="${escapeAttribute(skillPackage.packageId)}" event="${event.eventTypes.join("+")}">`,
    `# ${title}`,
    "Strength: L1 is optional reference; L2 is a recommendation; L3 is required guidance; L4 is a hard constraint.",
    ...steps,
    "Apply this guidance only where it is relevant to the current task, then continue working.",
    "</direct_skill_sop>",
  ].join("\n");
}

function renderValue(value: string | Record<string, any>): string {
  return typeof value === "string" ? value.trim() : JSON.stringify(value);
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
