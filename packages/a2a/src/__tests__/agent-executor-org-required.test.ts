/**
 * TDD scaffold for enforcing required organization context.
 *
 * Asserts that the external A2A executor reads `organizationId` from the
 * `withActorContext` ALS frame established by the A2A route layer, and:
 *
 *   - Publishes a terminal failed status-update with errorCode
 *     `ORG_CONTEXT_REQUIRED` AND does NOT call createAgentRun when the frame
 *     is missing or the org is undefined.
 *   - Threads `orgId: ctx.organizationId` into createAgentRun when the
 *     frame is present.
 *
 * NO BACKWARD COMPATIBILITY. The executor MUST NOT silently insert with
 * orgId omitted/null. Avoid `?? null` defaulting anywhere in this path.
 *
 * Both tests are RED until agent-executor.ts reads from the actor context.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stand up an in-test AsyncLocalStorage that the production code reads via
// `@cinatra-ai/llm`'s `getActorContext`. Because
// @cinatra-ai/a2a does not have @cinatra-ai/llm as a runtime dep
// in its vitest config, we hoist a stub module factory and let it use the
// same ALS instance we wrap calls with from the test.
const orchestrationStub = vi.hoisted(() => {
  const { AsyncLocalStorage } = require("node:async_hooks") as typeof import("node:async_hooks");
  const storage = new AsyncLocalStorage<unknown>();
  return {
    storage,
    actorContextStorage: storage,
    getActorContext: () => storage.getStore() as any,
    getActorContextOrThrow: () => {
      const ctx = storage.getStore();
      if (!ctx) {
        const err = new Error("ActorContext is required");
        (err as any).code = "ACTOR_CONTEXT_MISSING";
        throw err;
      }
      return ctx;
    },
    withActorContext: <T>(ctx: unknown, fn: () => Promise<T>): Promise<T> =>
      storage.run(ctx, fn),
  };
});
vi.mock("@cinatra-ai/llm", () => orchestrationStub);

// Hoisted spies for the @cinatra-ai/agents surface that agent-executor.ts uses.
// Must mock under "@cinatra/agent-builder" — vitest.config.ts aliases BOTH
// `@cinatra-ai/agents` and `@cinatra/agent-builder` to the same stub path, so
// a vi.mock factory registered against either name intercepts both imports.
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

import { InProcessAgentExecutor } from "../agent-executor";

function makeRequestContext(text: string): any {
  return {
    taskId: "task_org_1",
    contextId: "ctx_org_1",
    userMessage: { parts: [{ kind: "text", text }] },
  };
}

function makeEventBus() {
  const published: any[] = [];
  return {
    published,
    publish: vi.fn((e: any) => {
      published.push(e);
    }),
    finished: vi.fn(),
  };
}

const ALS_CTX = {
  principalType: "ExternalA2AAgent" as const,
  principalId: "ext-agent-1",
  organizationId: "org-A",
  authSource: "a2a" as const,
  policyVersion: "v2",
};

describe("InProcessAgentExecutor — org context required", () => {
  let executor: InProcessAgentExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    agentBuilder.jsonSchemaToZod.mockImplementation(realJsonSchemaToZod);
    agentBuilder.readAgentTemplateById.mockResolvedValue({
      id: "tpl_1",
      inputSchema: {},
    });
    agentBuilder.readAgentRunById.mockResolvedValue({ status: "completed" });
    executor = new InProcessAgentExecutor({
      templateId: "tpl_1",
      enqueueJob: vi.fn(async () => undefined) as any,
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
    } as any);
  });

  it("publishes ORG_CONTEXT_REQUIRED and does NOT create run when ALS frame is absent", async () => {
    const bus = makeEventBus();
    // Call execute() OUTSIDE any withActorContext wrap.
    await executor.execute(makeRequestContext("hi"), bus as any);

    const orgFailed = bus.published.filter(
      (e) =>
        e.status?.state === "failed" &&
        /ORG_CONTEXT_REQUIRED/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );
    expect(orgFailed.length).toBe(1);
    expect(orgFailed[0]?.status?.message?.parts?.[0]?.text).toMatch(
      /ORG_CONTEXT_REQUIRED/,
    );
    // The terminal event MUST be marked final.
    expect(orgFailed[0]?.final ?? orgFailed[0]?.status?.final).toBe(true);
    // No row must be inserted when org context cannot be resolved.
    expect(agentBuilder.createAgentRun).not.toHaveBeenCalled();
  });

  it("threads ctx.organizationId into createAgentRun when ALS frame has org", async () => {
    const bus = makeEventBus();
    await orchestrationStub.withActorContext(ALS_CTX, async () => {
      await executor.execute(makeRequestContext("hi"), bus as any);
    });

    expect(agentBuilder.createAgentRun).toHaveBeenCalledTimes(1);
    const call = (agentBuilder.createAgentRun.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ])[0];
    expect(call.orgId).toBe("org-A");
    // No ORG_CONTEXT_REQUIRED event should be emitted on the happy path.
    const orgFailed = bus.published.filter(
      (e) =>
        e.status?.state === "failed" &&
        /ORG_CONTEXT_REQUIRED/.test(e.status?.message?.parts?.[0]?.text ?? ""),
    );
    expect(orgFailed.length).toBe(0);
  });
});
