/**
 * Unit tests for the A2A boundary inputSchema enforcement.
 *
 *   pnpm vitest run src/__tests__/agent-executor-validation.test.ts
 * from `packages/a2a/`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const agentBuilder = vi.hoisted(() => ({
  createAgentRun: vi.fn(async () => undefined),
  readAgentRunById: vi.fn(async () => null as any),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  readAgentTemplateById: vi.fn(),
  jsonSchemaToZod: vi.fn(),
}));
vi.mock("@cinatra/agent-builder", () => agentBuilder);

vi.mock("../streaming-bridge", () => ({
  publishRunEvent: vi.fn(async () => undefined),
}));

// Re-import the real jsonSchemaToZod implementation to make the tests exercise
// actual Zod parsing rather than a stub — copy the minimal converter inline.
import { z } from "zod";
function realJsonSchemaToZod(schema: any): any {
  if (!schema || typeof schema !== "object") return z.record(z.string(), z.unknown());
  const t = schema.type;
  if (t === "string") return z.string();
  if (t === "number" || t === "integer") return z.number();
  if (t === "boolean") return z.boolean();
  if (t === "array") return z.array(realJsonSchemaToZod(schema.items ?? {}));
  if (t === "object") {
    const shape: any = {};
    const req: string[] = schema.required ?? [];
    for (const [k, v] of Object.entries(schema.properties ?? {})) {
      const zz = realJsonSchemaToZod(v);
      shape[k] = req.includes(k) ? zz : zz.optional();
    }
    return z.object(shape);
  }
  return z.record(z.string(), z.unknown());
}
agentBuilder.jsonSchemaToZod.mockImplementation(realJsonSchemaToZod);

import { InProcessAgentExecutor } from "../agent-executor";

function makeRequestContext(text: string): any {
  return {
    taskId: "task_1",
    contextId: "ctx_1",
    userMessage: { parts: [{ kind: "text", text }] },
  };
}

function makeEventBus() {
  const published: any[] = [];
  return {
    published,
    publish: vi.fn((e: any) => { published.push(e); }),
    finished: vi.fn(),
  };
}

describe("InProcessAgentExecutor — A2A inputSchema gate", () => {
  let executor: InProcessAgentExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    agentBuilder.jsonSchemaToZod.mockImplementation(realJsonSchemaToZod);
    executor = new InProcessAgentExecutor({
      templateId: "tpl_1",
      enqueueJob: vi.fn(async () => undefined) as any,
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
    } as any);
  });

  it("creates the run when inputParams satisfy the schema", async () => {
    agentBuilder.readAgentTemplateById.mockResolvedValueOnce({
      id: "tpl_1",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    });
    agentBuilder.readAgentRunById.mockResolvedValue({ status: "completed" });

    const bus = makeEventBus();
    await executor.execute(makeRequestContext(JSON.stringify({ prompt: "hi" })), bus as any);

    expect(agentBuilder.createAgentRun).toHaveBeenCalledTimes(1);
    const failedEvents = bus.published.filter(
      (e) => e.status?.state === "failed" && /INPUT_VALIDATION_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );
    expect(failedEvents.length).toBe(0);
  });

  it("publishes INPUT_VALIDATION_ERROR and does NOT create a run when inputParams are invalid", async () => {
    agentBuilder.readAgentTemplateById.mockResolvedValueOnce({
      id: "tpl_1",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    });

    const bus = makeEventBus();
    await executor.execute(makeRequestContext(JSON.stringify({})), bus as any);

    const failedEvents = bus.published.filter(
      (e) => e.status?.state === "failed" && /INPUT_VALIDATION_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );
    expect(failedEvents.length).toBe(1);
    expect(agentBuilder.createAgentRun).not.toHaveBeenCalled();
  });

  it("skips validation when template.inputSchema is empty", async () => {
    agentBuilder.readAgentTemplateById.mockResolvedValueOnce({
      id: "tpl_1",
      inputSchema: {},
    });
    agentBuilder.readAgentRunById.mockResolvedValue({ status: "completed" });

    const bus = makeEventBus();
    await executor.execute(makeRequestContext("anything"), bus as any);

    expect(agentBuilder.createAgentRun).toHaveBeenCalledTimes(1);
    const failedEvents = bus.published.filter(
      (e) => e.status?.state === "failed" && /INPUT_VALIDATION_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );
    expect(failedEvents.length).toBe(0);
  });

  it("skips validation when readAgentTemplateById returns null", async () => {
    agentBuilder.readAgentTemplateById.mockResolvedValueOnce(null);
    agentBuilder.readAgentRunById.mockResolvedValue({ status: "failed" });

    const bus = makeEventBus();
    await executor.execute(makeRequestContext(JSON.stringify({})), bus as any);

    const failedEvents = bus.published.filter(
      (e) => e.status?.state === "failed" && /INPUT_VALIDATION_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );
    expect(failedEvents.length).toBe(0);
  });
});

describe("InProcessAgentExecutor — error-code separation", () => {
  let executor: InProcessAgentExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    agentBuilder.jsonSchemaToZod.mockImplementation(realJsonSchemaToZod);
    executor = new InProcessAgentExecutor({
      templateId: "tpl_1",
      enqueueJob: vi.fn(async () => undefined) as any,
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
    } as any);
  });

  it("emits TEMPLATE_FETCH_ERROR (not INPUT_VALIDATION_ERROR) when readAgentTemplateById() throws", async () => {
    agentBuilder.readAgentTemplateById.mockRejectedValueOnce(
      new Error("db connection refused"),
    );

    const bus = makeEventBus();
    await executor.execute(makeRequestContext(JSON.stringify({ prompt: "hi" })), bus as any);

    const templateFetchEvents = bus.published.filter(
      (e) =>
        e.status?.state === "failed" &&
        /TEMPLATE_FETCH_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );
    const inputValidationEvents = bus.published.filter(
      (e) =>
        e.status?.state === "failed" &&
        /INPUT_VALIDATION_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );

    // MUST emit TEMPLATE_FETCH_ERROR exactly once
    expect(templateFetchEvents.length).toBe(1);
    // MUST NOT emit INPUT_VALIDATION_ERROR for a DB failure
    expect(inputValidationEvents.length).toBe(0);
    // MUST include a "Template fetch failed:" prefix in the message
    const msg = templateFetchEvents[0]?.status?.message?.parts?.[0]?.text ?? "";
    expect(msg).toMatch(/Template fetch failed:/);
    // MUST NOT create a run
    expect(agentBuilder.createAgentRun).not.toHaveBeenCalled();
  });

  it("emits INPUT_VALIDATION_ERROR when template is fetched successfully but inputParams fail schema", async () => {
    agentBuilder.readAgentTemplateById.mockResolvedValueOnce({
      id: "tpl_1",
      inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    });

    const bus = makeEventBus();
    await executor.execute(makeRequestContext(JSON.stringify({})), bus as any);

    const templateFetchEvents = bus.published.filter(
      (e) =>
        e.status?.state === "failed" &&
        /TEMPLATE_FETCH_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );
    const inputValidationEvents = bus.published.filter(
      (e) =>
        e.status?.state === "failed" &&
        /INPUT_VALIDATION_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );

    expect(inputValidationEvents.length).toBe(1);
    expect(templateFetchEvents.length).toBe(0);
    const msg = inputValidationEvents[0]?.status?.message?.parts?.[0]?.text ?? "";
    expect(msg).toMatch(/A2A input validation failed:/);
    expect(agentBuilder.createAgentRun).not.toHaveBeenCalled();
  });

  it("proceeds to createAgentRun when template has no inputSchema (opt-in behavior preserved)", async () => {
    agentBuilder.readAgentTemplateById.mockResolvedValueOnce({
      id: "tpl_1",
      inputSchema: {},
    });
    agentBuilder.readAgentRunById.mockResolvedValue({ status: "completed" });

    const bus = makeEventBus();
    await executor.execute(makeRequestContext("anything"), bus as any);

    expect(agentBuilder.createAgentRun).toHaveBeenCalledTimes(1);
    const failedEvents = bus.published.filter(
      (e) =>
        e.status?.state === "failed" &&
        (/TEMPLATE_FETCH_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? "") ||
          /INPUT_VALIDATION_ERROR/.test(e.status?.message?.parts?.[0]?.text ?? "")),
    );
    expect(failedEvents.length).toBe(0);
  });
});
