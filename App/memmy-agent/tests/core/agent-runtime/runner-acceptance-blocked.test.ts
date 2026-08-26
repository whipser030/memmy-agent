import { describe, expect, it } from "vitest";
import { AgentHook, AgentHookContext } from "../../../src/core/agent-runtime/hook.js";
import { AgentRunner, AgentRunSpec, MAX_REWRITE_CONTINUATIONS } from "../../../src/core/agent-runtime/runner.js";
import { LLMResponse, ToolCallRequest } from "../../../src/providers/base.js";

describe("AgentRunner persistent acceptance gate", () => {
  it("accepts the third original model output after two rewrite continuations", async () => {
    let calls = 0;
    const checkpoints: Array<Record<string, unknown>> = [];
    const provider = {
      chatWithRetry: async () => {
        calls += 1;
        return new LLMResponse({ content: `unverified draft ${calls}` });
      },
    };
    class PersistentGate extends AgentHook {
      override async rewrite_llm_content(_context: AgentHookContext, content: string | null) {
        return {
          content: `self-review:${content}`,
          action: "continue" as const,
          discardToolCalls: true,
          reason: "INT-07",
        };
      }
    }

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "produce the verified final artifact" }],
      maxIterations: 6,
      hook: new PersistentGate(),
      checkpointCallback: async (checkpoint) => { checkpoints.push(checkpoint as unknown as Record<string, unknown>); },
    }));

    expect(calls).toBe(MAX_REWRITE_CONTINUATIONS + 1);
    expect(result.stopReason).toBe("completed");
    expect(result.error).toBeNull();
    expect(result.finalContent).toBe(`unverified draft ${MAX_REWRITE_CONTINUATIONS + 1}`);
    expect(result.messages.at(-1)?.content).toBe(`unverified draft ${MAX_REWRITE_CONTINUATIONS + 1}`);
    expect(checkpoints.at(-1)).not.toMatchObject({ phase: "acceptanceBlocked" });
  });

  it("still executes corrective tools after the text-only continuation limit", async () => {
    let calls = 0;
    let toolExecutions = 0;
    const provider = {
      chatWithRetry: async () => {
        calls += 1;
        if (calls === 3) {
          return new LLMResponse({
            content: "I will verify it now",
            toolCalls: [new ToolCallRequest({ id: "verify-1", name: "validator", arguments: {} })],
          });
        }
        return new LLMResponse({ content: calls < 3 ? `unverified draft ${calls}` : "verified answer" });
      },
    };
    class GateUntilTool extends AgentHook {
      override async rewrite_llm_content(context: AgentHookContext, content: string | null) {
        if ((context.iteration ?? 0) >= 3) return content;
        return { content, action: "continue" as const, reason: "INT-07" };
      }
    }
    const tools = {
      getDefinitions: () => [],
      get: () => null,
      execute: async () => {
        toolExecutions += 1;
        return "validation passed";
      },
    };

    const result = await new AgentRunner(provider as any).run(new AgentRunSpec({
      messages: [{ role: "user", content: "produce the verified final artifact" }],
      tools,
      maxIterations: 6,
      hook: new GateUntilTool(),
    }));

    expect(toolExecutions).toBe(1);
    expect(result.stopReason).toBe("completed");
    expect(result.finalContent).toBe("verified answer");
  });
});
