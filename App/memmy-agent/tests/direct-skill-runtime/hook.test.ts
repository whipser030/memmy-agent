import { describe, expect, it, vi } from "vitest";
import { AgentHookContext } from "../../src/core/agent-runtime/hook.js";
import { DirectSkillRuntimeHook } from "../../src/direct-skill-runtime/hook.js";
import type { DirectSkillModule } from "../../src/direct-skill-runtime/types.js";
import type { DirectSkillInterventionMode } from "../../src/direct-skill-runtime/types.js";

function fixture(interventionMode: DirectSkillInterventionMode = "full") {
  const modules: DirectSkillModule[] = [
    { moduleId: "start", strength: "L1", instruction: "Inspect the workbook first.", triggerEvents: ["turn_start"] },
    { moduleId: "error", instruction: "Recover from this tool error.", triggerEvents: ["tool_error"] },
    { moduleId: "loop", instruction: "Break the repeated tool loop.", triggerEvents: ["no_progress"] },
    { moduleId: "submit", instruction: "Check the requested output before submitting.", triggerEvents: ["before_submit"] },
  ];
  const client = {
    routeDirectSkillPackage: vi.fn(async () => ({ package: { packageId: "pkg", title: "Spreadsheet SOP", modules } })),
    selectDirectSkillModules: vi.fn(async (request: any) => ({ selectedModuleIds: [request.candidateModuleIds[0]] })),
  };
  const memoryRuntime = {
    requestEnvelope: vi.fn(() => ({ source: "test" })),
    currentUserText: vi.fn(() => "fix this workbook"),
  };
  const injections: any[] = [];
  const spec: any = {
    messages: [{ role: "user", content: "fix this workbook" }],
    turnId: "turn-1",
    sessionKey: "session-1",
    injectionEnqueueCallback: (payload: any) => {
      injections.push(payload);
      return true;
    },
  };
  const hook = new DirectSkillRuntimeHook(client as any, memoryRuntime as any, interventionMode);
  return { hook, client, spec, injections };
}

describe("DirectSkillRuntimeHook", () => {
  it("routes one package and enqueues turn-start guidance", async () => {
    const { hook, client, spec, injections } = fixture();
    await hook.beforeRun(new AgentHookContext({ spec, messages: spec.messages }));
    expect(client.routeDirectSkillPackage).toHaveBeenCalledOnce();
    expect(client.selectDirectSkillModules).toHaveBeenCalledWith(expect.objectContaining({
      packageId: "pkg",
      candidateModuleIds: ["start"],
      event: expect.objectContaining({ eventTypes: ["turn_start"] }),
    }));
    expect(injections[0]).toMatchObject({
      directSkillIntervention: { taskKey: "turn-1", packageId: "pkg", moduleIds: ["start"] },
    });
  });

  it("does not create state for goal continuations", async () => {
    const { hook, client, spec, injections } = fixture();
    spec.internalTurnContext = { kind: "goal_continuation", goalId: "goal", objective: "continue" };
    await hook.beforeRun(new AgentHookContext({ spec, messages: spec.messages }));
    expect(client.routeDirectSkillPackage).not.toHaveBeenCalled();
    expect(injections).toEqual([]);
  });

  it("coalesces tool_error and no_progress in one selection", async () => {
    const { hook, client, spec } = fixture();
    await hook.beforeRun(new AgentHookContext({ spec, messages: spec.messages }));
    client.selectDirectSkillModules.mockClear();
    const batch = () => new AgentHookContext({
      spec,
      messages: spec.messages,
      toolCalls: [{ name: "read_file", arguments: { path: "same.xlsx" } }],
      toolResults: ["Error: failed"],
      toolEvents: [{ name: "read_file", status: "error", detail: "failed" }],
    });
    await hook.afterToolBatch(batch());
    await hook.afterToolBatch(batch());
    await hook.afterToolBatch(batch());
    expect(client.selectDirectSkillModules).toHaveBeenCalledTimes(2);
    const lastRequest = client.selectDirectSkillModules.mock.calls.at(-1)?.[0] as any;
    expect(lastRequest.event.eventTypes)
      .toEqual(["tool_error", "no_progress"]);
  });

  it("allows at most one accepted before-submit intervention", async () => {
    const { hook, client, spec, injections } = fixture();
    await hook.beforeRun(new AgentHookContext({ spec, messages: spec.messages }));
    client.selectDirectSkillModules.mockClear();
    const context = new AgentHookContext({ spec, messages: spec.messages, finalContent: "draft" });
    await hook.beforeFinalResponse(context);
    await hook.beforeFinalResponse(context);
    expect(client.selectDirectSkillModules).toHaveBeenCalledOnce();
    expect(injections.at(-1)?.directSkillIntervention.moduleIds).toEqual(["submit"]);
  });

  it("filters candidates whose tool scope is unavailable", async () => {
    const { hook, client, spec } = fixture();
    client.routeDirectSkillPackage.mockResolvedValueOnce({
      package: {
        packageId: "pkg",
        title: "Spreadsheet SOP",
        modules: [{
          moduleId: "excel-only",
          instruction: "Edit the workbook.",
          triggerEvents: ["turn_start"],
          scope: { tools: ["spreadsheet_edit"] },
        }],
      },
    });
    spec.tools = { getDefinitions: () => [{ function: { name: "read_file" } }] } as any;
    await hook.beforeRun(new AgentHookContext({ spec, messages: spec.messages }));
    expect(client.selectDirectSkillModules).not.toHaveBeenCalled();
  });

  it("static mode only handles turn_start", async () => {
    const { hook, client, spec } = fixture("static");
    await hook.beforeRun(new AgentHookContext({ spec, messages: spec.messages }));
    client.selectDirectSkillModules.mockClear();
    await hook.afterToolBatch(new AgentHookContext({
      spec,
      messages: spec.messages,
      toolCalls: [{ name: "read_file", arguments: {} }],
      toolResults: ["Error: failed"],
      toolEvents: [{ status: "error" }],
    }));
    await hook.beforeFinalResponse(new AgentHookContext({ spec, messages: spec.messages, finalContent: "draft" }));
    expect(client.selectDirectSkillModules).not.toHaveBeenCalled();
  });

  it("dynamic mode handles tool events but not before_submit", async () => {
    const { hook, client, spec } = fixture("dynamic");
    await hook.beforeRun(new AgentHookContext({ spec, messages: spec.messages }));
    client.selectDirectSkillModules.mockClear();
    await hook.afterToolBatch(new AgentHookContext({
      spec,
      messages: spec.messages,
      toolCalls: [{ name: "read_file", arguments: {} }],
      toolResults: ["Error: failed"],
      toolEvents: [{ status: "error" }],
    }));
    expect(client.selectDirectSkillModules).toHaveBeenCalledOnce();
    client.selectDirectSkillModules.mockClear();
    await hook.beforeFinalResponse(new AgentHookContext({ spec, messages: spec.messages, finalContent: "draft" }));
    expect(client.selectDirectSkillModules).not.toHaveBeenCalled();
  });
});
