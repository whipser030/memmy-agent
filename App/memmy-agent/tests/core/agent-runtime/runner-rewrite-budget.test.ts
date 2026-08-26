import { describe, expect, it } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec, MAX_REWRITE_CONTINUATIONS } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

type RewriteBudget = {
  used: number;
  max: number;
  exhausted: boolean;
};

function readRewriteBudget(context: AgentHookContext): RewriteBudget {
  return context.metadata.rewriteBudget as RewriteBudget;
}

describe("AgentRunner rewrite continuation budget", () => {
  it("reports the budget to hooks and preserves the original response at the limit", async () => {
    let calls = 0;
    const observedBudgets: RewriteBudget[] = [];
    const provider = {
      chatWithRetry: async () => {
        calls += 1;
        return new LLMResponse({ content: `model response ${calls}` });
      },
    };
    class AlwaysContinueHook extends AgentHook {
      override async rewrite_llm_content(context: AgentHookContext, content: string | null) {
        observedBudgets.push({ ...readRewriteBudget(context) });
        return {
          content: `rewritten:${content}`,
          action: "continue" as const,
          discardToolCalls: true,
          reason: "test-continuation",
        };
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "produce a final response" }],
      maxIterations: 6,
      hook: new AlwaysContinueHook(),
    }));

    expect(observedBudgets).toEqual([
      { used: 0, max: MAX_REWRITE_CONTINUATIONS, exhausted: false },
      { used: 1, max: MAX_REWRITE_CONTINUATIONS, exhausted: false },
      { used: 2, max: MAX_REWRITE_CONTINUATIONS, exhausted: true },
    ]);
    expect(calls).toBe(MAX_REWRITE_CONTINUATIONS + 1);
    expect(result.stopReason).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.finalContent).toBe(`model response ${MAX_REWRITE_CONTINUATIONS + 1}`);
    expect(result.messages.at(-1)?.content).toBe(`model response ${MAX_REWRITE_CONTINUATIONS + 1}`);
  });

  it("preserves tool calls when a hook requests continuation after the limit", async () => {
    let calls = 0;
    let toolExecutions = 0;
    const provider = {
      chatWithRetry: async () => {
        calls += 1;
        if (calls === 3) {
          return new LLMResponse({
            content: "run the tool",
            toolCalls: [new ToolCallRequest({ id: "tool-1", name: "worker-tool", arguments: {} })],
          });
        }
        return new LLMResponse({ content: calls < 3 ? `model response ${calls}` : "final response" });
      },
    };
    class AlwaysContinueHook extends AgentHook {
      override async rewrite_llm_content(_context: AgentHookContext, content: string | null) {
        return {
          content,
          action: "continue" as const,
          discardToolCalls: true,
          reason: "test-continuation",
        };
      }
    }
    const tools = {
      getDefinitions: () => [],
      get: () => null,
      execute: async () => {
        toolExecutions += 1;
        return "tool completed";
      },
    };

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "produce a final response" }],
      tools,
      maxIterations: 6,
      hook: new AlwaysContinueHook(),
    }));

    expect(toolExecutions).toBe(1);
    expect(result.stopReason).toBe("completed");
    expect(result.finalContent).toBe("final response");
  });
});
