import { createHash } from "node:crypto";
import { AgentHook, AgentHookContext } from "../core/agent-runtime/hook.js";
import type { MemmyMemoryClient } from "../memmy-memory/client.js";
import type { MemmyMemoryToolRuntime } from "../memmy-memory/types.js";
import { renderDirectSkillSop } from "./renderer.js";
import type {
  DirectSkillEventType,
  DirectSkillInjection,
  DirectSkillInterventionMode,
  DirectSkillModule,
  DirectSkillPackage,
  DirectSkillTaskState,
  RuntimeEventBatch,
} from "./types.js";

export class DirectSkillRuntimeHook extends AgentHook {
  private readonly states = new Map<string, DirectSkillTaskState>();

  constructor(
    private readonly client: MemmyMemoryClient,
    private readonly memoryRuntime: MemmyMemoryToolRuntime,
    private readonly interventionMode: DirectSkillInterventionMode = "full",
  ) {
    super(false);
  }

  override async beforeRun(ctx: AgentHookContext): Promise<void> {
    const spec = ctx.spec;
    const taskKey = stringValue(spec?.turnId);
    if (!taskKey || spec?.internalTurnContext?.kind === "goal_continuation") return;
    const state: DirectSkillTaskState = {
      taskKey,
      package: null,
      recentToolSignatures: [],
      emittedFingerprints: new Set(),
      injectedModuleIds: new Set(),
      beforeSubmitIntervened: false,
    };
    this.states.set(taskKey, state);
    const sessionKey = stringValue(spec?.sessionKey);
    const query = this.memoryRuntime.currentUserText(sessionKey) ?? lastUserText(ctx.messages);
    if (!query) return;
    const response = await this.client.routeDirectSkillPackage({
      ...this.memoryRuntime.requestEnvelope(sessionKey),
      query,
      toolNames: toolNames(spec?.tools),
      workspace: stringValue(spec?.workspace) ?? undefined,
    });
    state.package = normalizePackage(response?.package ?? response?.skillPackage ?? null);
    if (!state.package) return;
    await this.selectAndEnqueue(ctx, state, {
      eventTypes: ["turn_start"],
      occurredAt: new Date().toISOString(),
    });
  }

  override async afterToolBatch(ctx: AgentHookContext): Promise<void> {
    if (this.interventionMode === "static") return;
    const state = this.stateFor(ctx);
    if (!state?.package) return;
    const calls = Array.isArray(ctx.toolCalls) ? ctx.toolCalls : [];
    const results = Array.isArray(ctx.toolResults) ? ctx.toolResults : [];
    const events = Array.isArray(ctx.toolEvents) ? ctx.toolEvents : [];
    const eventTypes: DirectSkillEventType[] = [];
    if (events.some((event) => String(event?.status ?? "").toLowerCase() === "error")) {
      eventTypes.push("tool_error");
    }
    const signatures = calls.map((call, index) => toolSignature(call, results[index], events[index]));
    state.recentToolSignatures.push(...signatures);
    state.recentToolSignatures = state.recentToolSignatures.slice(-3);
    if (
      state.recentToolSignatures.length === 3
      && new Set(state.recentToolSignatures).size === 1
    ) {
      eventTypes.push("no_progress");
    }
    if (!eventTypes.length) return;
    await this.selectAndEnqueue(ctx, state, {
      eventTypes,
      occurredAt: new Date().toISOString(),
      toolCalls: calls,
      toolResults: results,
      toolEvents: events,
    });
  }

  override async beforeFinalResponse(ctx: AgentHookContext): Promise<void> {
    if (this.interventionMode !== "full") return;
    const state = this.stateFor(ctx);
    if (!state?.package || state.beforeSubmitIntervened) return;
    const enqueued = await this.selectAndEnqueue(ctx, state, {
      eventTypes: ["before_submit"],
      occurredAt: new Date().toISOString(),
      draftFinalAnswer: stringValue(ctx.finalContent) ?? stringValue(ctx.response?.content) ?? "",
    });
    if (enqueued) state.beforeSubmitIntervened = true;
  }

  override async afterRun(ctx: AgentHookContext): Promise<void> {
    const taskKey = stringValue(ctx.spec?.turnId);
    if (taskKey) this.states.delete(taskKey);
  }

  private stateFor(ctx: AgentHookContext): DirectSkillTaskState | null {
    const taskKey = stringValue(ctx.spec?.turnId);
    return taskKey ? this.states.get(taskKey) ?? null : null;
  }

  private async selectAndEnqueue(
    ctx: AgentHookContext,
    state: DirectSkillTaskState,
    event: RuntimeEventBatch,
  ): Promise<boolean> {
    const skillPackage = state.package;
    const enqueue = ctx.spec?.injectionEnqueueCallback;
    if (!skillPackage || typeof enqueue !== "function") return false;
    const fingerprint = eventFingerprint(event);
    if (state.emittedFingerprints.has(fingerprint)) return false;
    const candidates = skillPackage.modules.filter((module) => (
      !state.injectedModuleIds.has(module.moduleId)
      && module.triggerEvents.some((trigger) => event.eventTypes.includes(trigger))
      && moduleMatchesToolScope(module, event, ctx.spec?.tools)
    ));
    if (!candidates.length) {
      state.emittedFingerprints.add(fingerprint);
      return false;
    }
    const response = await this.client.selectDirectSkillModules({
      ...this.memoryRuntime.requestEnvelope(stringValue(ctx.spec?.sessionKey)),
      packageId: skillPackage.packageId,
      candidateModuleIds: candidates.map((module) => module.moduleId),
      event,
      taskMessages: observableTaskMessages(ctx),
      ...(event.draftFinalAnswer ? { draftFinalAnswer: event.draftFinalAnswer } : {}),
    });
    const selectedIds = uniqueStrings(response?.selectedModuleIds)
      .filter((moduleId) => candidates.some((module) => module.moduleId === moduleId));
    const selected = selectedIds
      .map((moduleId) => candidates.find((module) => module.moduleId === moduleId))
      .filter((module): module is DirectSkillModule => Boolean(module));
    state.emittedFingerprints.add(fingerprint);
    if (!selected.length) return false;
    const injection: DirectSkillInjection = {
      content: renderDirectSkillSop(skillPackage, selected, event),
      directSkillIntervention: {
        taskKey: state.taskKey,
        packageId: skillPackage.packageId,
        eventTypes: [...event.eventTypes],
        moduleIds: selected.map((module) => module.moduleId),
        injectedAt: new Date().toISOString(),
      },
    };
    const accepted = enqueue(injection) === true;
    if (!accepted) return false;
    for (const module of selected) state.injectedModuleIds.add(module.moduleId);
    return true;
  }
}

function normalizePackage(value: any): DirectSkillPackage | null {
  if (!value || typeof value !== "object") return null;
  const packageId = stringValue(value.packageId ?? value.id);
  if (!packageId || !Array.isArray(value.modules)) return null;
  const modules = value.modules
    .map((module: any) => normalizeModule(module))
    .filter((module: DirectSkillModule | null): module is DirectSkillModule => Boolean(module));
  if (!modules.length) return null;
  return { ...value, packageId, modules };
}

function normalizeModule(value: any): DirectSkillModule | null {
  if (!value || typeof value !== "object") return null;
  const moduleId = stringValue(value.moduleId ?? value.id);
  const instruction = stringValue(value.instruction);
  if (!moduleId || !instruction) return null;
  const triggerEvents = uniqueStrings(value.triggerEvents)
    .filter(isDirectSkillEventType);
  if (!triggerEvents.length) return null;
  return { ...value, moduleId, instruction, triggerEvents };
}

function isDirectSkillEventType(value: string): value is DirectSkillEventType {
  return ["turn_start", "tool_error", "no_progress", "before_submit"].includes(value);
}

function eventFingerprint(event: RuntimeEventBatch): string {
  return createHash("sha256").update(JSON.stringify({
    eventTypes: [...event.eventTypes].sort(),
    calls: event.toolCalls?.map((call) => ({ name: call?.name, arguments: call?.arguments })),
    events: event.toolEvents?.map((item) => ({ status: item?.status, detail: item?.detail })),
  })).digest("hex");
}

function toolSignature(call: any, result: any, event: any): string {
  return createHash("sha256").update(JSON.stringify({
    name: call?.name ?? call?.function?.name ?? "",
    arguments: stableValue(call?.arguments ?? call?.function?.arguments ?? call?.params ?? null),
    status: event?.status ?? null,
    result: summarize(result),
  })).digest("hex");
}

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function summarize(value: any): string {
  const text = typeof value === "string" ? value : JSON.stringify(stableValue(value));
  return String(text ?? "").replace(/\s+/gu, " ").trim().slice(0, 500);
}

function toolNames(tools: any): string[] {
  const definitions = tools?.getDefinitions?.();
  if (!Array.isArray(definitions)) return [];
  return uniqueStrings(definitions.map((definition) => definition?.function?.name ?? definition?.name));
}

function moduleMatchesToolScope(module: DirectSkillModule, event: RuntimeEventBatch, tools: any): boolean {
  const scopedTools = uniqueStrings(module.scope?.tools ?? module.scope?.toolNames).map(normalizeToolName);
  if (!scopedTools.length || scopedTools.includes("*") || scopedTools.includes("any")) return true;
  const batchTools = uniqueStrings((event.toolCalls ?? []).map((call) => call?.name ?? call?.function?.name))
    .map(normalizeToolName);
  const relevantTools = batchTools.length ? batchTools : toolNames(tools).map(normalizeToolName);
  return relevantTools.some((toolName) => scopedTools.includes(toolName));
}

function normalizeToolName(value: string): string {
  return value.trim().toLowerCase();
}

function lastUserText(messages: Record<string, any>[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim();
  }
  return "";
}

function observableTaskMessages(ctx: AgentHookContext): Record<string, any>[] {
  const messages = Array.isArray(ctx.messages) ? ctx.messages : [];
  const rawStart = ctx.spec?.currentTurnMessageStartIndex;
  const start = Number.isInteger(rawStart) && rawStart >= 0 ? rawStart : 0;
  return messages.slice(start).filter((message) => message?.role !== "system").map((message) => {
    const copy = { ...message };
    delete copy.direct_skill_intervention;
    return copy;
  });
}

function uniqueStrings(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(stringValue).filter((item): item is string => Boolean(item)))];
}

function stringValue(value: any): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
