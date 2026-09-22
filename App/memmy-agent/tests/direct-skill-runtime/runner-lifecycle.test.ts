import { describe, expect, it, vi } from "vitest";
import { AgentRunSpec, AgentRunner } from "../../src/core/agent-runtime/runner.js";
import { AgentHook, AgentHookContext } from "../../src/core/agent-runtime/hook.js";
import { LLMResponse } from "../../src/providers/base.js";

describe("Direct Skill injection lifecycle", () => {
  it("drains before the first model request and logs only the drained intervention", async () => {
    const intervention = {
      taskKey: "turn-1",
      packageId: "pkg",
      eventTypes: ["turn_start"] as Array<"turn_start">,
      moduleIds: ["start"],
      injectedAt: "2026-01-01T00:00:00.000Z",
    };
    const queued: any[] = [];
    class TurnStartHook extends AgentHook {
      override async beforeRun(ctx: AgentHookContext): Promise<void> {
        ctx.spec?.injectionEnqueueCallback?.({
          content: "use this SOP",
          directSkillIntervention: intervention,
        });
      }
    }
    const provider = {
      getDefaultModel: () => "test-model",
      chatWithRetry: vi.fn(async (_args: any) => new LLMResponse({ content: "done" })),
    };
    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "task" }],
      provider: provider as any,
      tools: { getDefinitions: () => [] },
      maxIterations: 1,
      hook: new TurnStartHook(),
      injectionEnqueueCallback: (payload) => {
        queued.push({
          role: "user",
          content: payload.content,
          direct_skill_intervention: payload.directSkillIntervention,
        });
        return true;
      },
      injectionCallback: ({ limit = 3 } = {}) => queued.splice(0, limit),
    }));
    expect(provider.chatWithRetry.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: "task\n\nuse this SOP" },
    ]);
    expect(result.directSkillInterventions).toEqual([
      expect.objectContaining({ ...intervention, injectedAt: expect.any(String) }),
    ]);
  });
});
