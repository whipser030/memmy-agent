import assert from "node:assert/strict";
import test from "node:test";
import plugin from "./index.js";

function makeHarness({ directSkillOnly = true, directSkillMode = "package_v1" } = {}) {
  const hooks = new Map();
  const middleware = [];
  const completed = [];
  const requests = [];
  const tools = [];
  const memoryCapabilities = [];
  const services = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push({ path, body });
    let payload;
    if (path.endsWith("/sessions/open")) payload = { sessionId: "session-1" };
    else if (path.endsWith("/turns/start")) payload = { turnId: "turn-1", injectedContext: "ordinary memory" };
    else if (path.endsWith("/direct-skills/route-package")) payload = {
      package: {
        packageId: "package-1",
        title: "Spreadsheet recovery",
        modules: [
          { moduleId: "start", strength: "L1", instruction: "Inspect the workbook first.", triggerEvents: ["turn_start"] },
          { moduleId: "error", strength: "L2", instruction: "Recover from the failed tool call.", triggerEvents: ["tool_error"] },
          { moduleId: "loop", strength: "L2", instruction: "Stop repeating the same ineffective call.", triggerEvents: ["no_progress"] },
          { moduleId: "submit", strength: "L3", instruction: "Reopen and verify the output.", scope: { tools: ["LibreOffice"] }, triggerEvents: ["before_submit"], completionRule: "Workbook reopens." },
        ],
      },
    };
    else if (path.endsWith("/direct-skills/select-modules")) payload = { selectedModuleIds: [body.candidateModuleIds[0]] };
    else if (path.includes("/complete")) { completed.push(body); payload = { ok: true }; }
    else if (path.endsWith("/health")) payload = { ok: true, capabilities: { directSkillMode } };
    else payload = { ok: true };
    return { ok: true, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  const api = {
    pluginConfig: { directSkillOnly },
    registerTool(tool) { tools.push(tool); },
    registerMemoryCapability(capability) { memoryCapabilities.push(capability); },
    registerService(service) { services.push(service); },
    registerAgentToolResultMiddleware(handler, options) { middleware.push({ handler, options }); },
    on(name, handler) { hooks.set(name, handler); },
    logger: { warn(message) { throw new Error(message); } },
  };
  plugin.register(api);
  return { hooks, middleware, completed, requests, tools, memoryCapabilities, services };
}

test("registers the official OpenClaw hooks and middleware contract", () => {
  const { hooks, middleware, tools, memoryCapabilities } = makeHarness();
  assert.ok(hooks.has("before_prompt_build"));
  assert.ok(hooks.has("after_tool_call"));
  assert.ok(hooks.has("before_agent_finalize"));
  assert.ok(hooks.has("agent_end"));
  assert.equal(middleware.length, 1);
  assert.deepEqual(middleware[0].options.runtimes, ["openclaw"]);
  assert.equal(tools.length, 0);
  assert.equal(memoryCapabilities.length, 0);
});

test("keeps generic memory tools available outside direct-skill-only mode", () => {
  const { tools, memoryCapabilities } = makeHarness({ directSkillOnly: false });
  assert.equal(tools.length, 6);
  assert.equal(memoryCapabilities.length, 1);
});

test("fails startup when direct-skill-only mode is backed by a legacy server", async () => {
  const { services } = makeHarness({ directSkillMode: "legacy" });
  await assert.rejects(
    services[0].start(),
    /requires algorithm\.skill\.directMode=package_v1/
  );
});

test("accepts startup when package-v1 routing is active", async () => {
  const { services } = makeHarness();
  await services[0].start();
});

test("injects turn-start, tool-error, and before-submit modules at the right seams", async () => {
  const { hooks, middleware, completed, requests } = makeHarness();
  const ctx = { runId: "run-1", sessionKey: "task-1", sessionId: "native-1", agentId: "main", workspaceDir: "/tmp/work" };
  const started = await hooks.get("before_prompt_build")({ prompt: "Fix the spreadsheet", messages: [{ role: "user", content: "Fix the spreadsheet" }] }, ctx);
  assert.doesNotMatch(started.prependContext, /ordinary memory/);
  assert.match(started.prependContext, /Inspect the workbook first/);
  const turnStart = requests.find((request) => request.path.endsWith("/turns/start"));
  assert.deepEqual(turnStart.body.layers, []);

  const transformed = await middleware[0].handler({
    toolCallId: "call-1", toolName: "exec", args: { command: "false" }, isError: true,
    result: { content: [{ type: "text", text: "failed" }], details: { exitCode: 1 } },
  }, { ...ctx, runtime: "openclaw" });
  assert.match(transformed.result.content.at(-1).text, /Recover from the failed tool call/);

  const finalized = await hooks.get("before_agent_finalize")({ runId: "run-1", sessionId: "native-1", lastAssistantMessage: "Done", messages: [] }, ctx);
  assert.equal(finalized.action, "revise");
  assert.match(finalized.retry.instruction, /Reopen and verify the output/);
  assert.equal(finalized.retry.maxAttempts, 1);

  await hooks.get("agent_end")({ runId: "run-1", success: true, messages: [{ role: "assistant", content: "Done" }] }, ctx);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].directSkillInterventions.length, 3);
  assert.equal(completed[0].toolCalls.length, 1);
  assert.equal(completed[0].toolResults.length, 1);
});

test("injects no-progress guidance after three identical tool results", async () => {
  const { hooks, middleware } = makeHarness();
  const ctx = { runId: "run-loop", sessionKey: "task-loop", sessionId: "native-loop", agentId: "main" };
  await hooks.get("before_prompt_build")({ prompt: "Fix the spreadsheet", messages: [] }, ctx);
  const event = {
    toolCallId: "call-loop", toolName: "exec", args: { command: "inspect" }, isError: false,
    result: { content: [{ type: "text", text: "unchanged" }], details: {} },
  };
  assert.equal(await middleware[0].handler(event, { ...ctx, runtime: "openclaw" }), undefined);
  assert.equal(await middleware[0].handler(event, { ...ctx, runtime: "openclaw" }), undefined);
  const transformed = await middleware[0].handler(event, { ...ctx, runtime: "openclaw" });
  assert.match(transformed.result.content.at(-1).text, /Stop repeating the same ineffective call/);
});

test("captures typed after-tool-call events when result middleware is not invoked", async () => {
  const { hooks, completed } = makeHarness();
  const ctx = { runId: "run-typed", sessionKey: "task-typed", sessionId: "native-typed", agentId: "main" };
  await hooks.get("before_prompt_build")({ prompt: "Fix the spreadsheet", messages: [] }, ctx);
  hooks.get("after_tool_call")({
    runId: ctx.runId,
    toolCallId: "typed-1",
    toolName: "exec",
    params: { command: "python build.py" },
    result: { content: [{ type: "text", text: "ok" }] },
    durationMs: 10,
  }, ctx);
  await hooks.get("agent_end")({ runId: ctx.runId, success: true, messages: [{ role: "assistant", content: "Done" }] }, ctx);

  assert.equal(completed[0].toolCalls.length, 1);
  assert.deepEqual(completed[0].toolCalls[0], {
    id: "typed-1",
    name: "exec",
    arguments: { command: "python build.py" },
  });
  assert.equal(completed[0].toolResults.length, 1);
});

test("captures failed turns even when the runtime emits no final answer", async () => {
  const { hooks, completed } = makeHarness();
  const ctx = { runId: "run-failed", sessionKey: "task-failed", sessionId: "native-failed", agentId: "main" };
  await hooks.get("before_prompt_build")({ prompt: "Create the report", messages: [] }, ctx);
  await hooks.get("agent_end")({
    runId: ctx.runId,
    success: false,
    error: { message: "Context overflow" },
    messages: [{ role: "user", content: "Create the report" }],
  }, ctx);

  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, "failed");
  assert.match(completed[0].answer, /without a final assistant answer/);
  assert.match(completed[0].answer, /Context overflow/);
});

test("treats OpenClaw isError terminal events as failed", async () => {
  const { hooks, completed } = makeHarness();
  const ctx = { runId: "run-is-error", sessionKey: "task-is-error", agentId: "main" };
  await hooks.get("before_prompt_build")({ prompt: "Create the report", messages: [] }, ctx);
  await hooks.get("agent_end")({
    runId: ctx.runId,
    isError: true,
    messages: [{ role: "assistant", content: "Partial result" }],
  }, ctx);

  assert.equal(completed[0].status, "failed");
});

test("flushes an unfinished turn when the session ends", async () => {
  const { hooks, completed } = makeHarness();
  const ctx = { runId: "run-ended", sessionKey: "task-ended", agentId: "main" };
  await hooks.get("before_prompt_build")({ prompt: "Create the report", messages: [] }, ctx);
  await hooks.get("session_end")({}, ctx);

  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, "failed");
  assert.match(completed[0].answer, /before OpenClaw emitted a terminal agent result/);
});

test("uses a distinct memory session id for a resume run", async () => {
  process.env.MEMMY_SESSION_ID_SUFFIX = "resume-1";
  try {
    const { hooks, requests } = makeHarness();
    const ctx = { runId: "run-resume", sessionKey: "task-resume", sessionId: "native-resume", agentId: "main" };
    await hooks.get("before_prompt_build")({ prompt: "Resume the report", messages: [] }, ctx);
    const opened = requests.find((request) => request.path.endsWith("/sessions/open"));
    assert.equal(opened.body.sessionId, "openclaw:task-resume:resume-1");
  } finally {
    delete process.env.MEMMY_SESSION_ID_SUFFIX;
  }
});
