/**
 * cinatra#2202 — COMPOSED pin: real ALS frame → real `createInProcessA2AClient`
 * → real SDK request handler → real `InProcessAgentExecutor`.
 *
 * The host-side unit test (packages/agents a2a-actions-internal-actor.test.ts)
 * pins that `sendAgentBuilderMessage` establishes the frame, but it mocks the
 * A2A client. This suite closes the other half: a frame established around
 * `client.sendMessage(...)` really IS still active by the time the executor
 * reads it, ACROSS the SDK's request-handler boundary
 * — and the three fields the executor derives from the actor (`orgId`,
 * `runBy`, `parentOboCeiling`) arrive at the guarded creation contract.
 *
 * The ALS carrier is a test-owned AsyncLocalStorage (same technique as
 * agent-executor-org-required.test.ts) so "no frame" really means undefined —
 * the package's default llm stub otherwise substitutes a fallback context.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const orchestrationStub = vi.hoisted(() => {
  // `require` (not a top-level import): a vi.hoisted factory is evaluated
  // BEFORE this module's imports are initialized, so an imported binding would
  // still be undefined here. Same technique as agent-executor-org-required.test.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AsyncLocalStorage } = require("node:async_hooks") as typeof import("node:async_hooks");
  const storage = new AsyncLocalStorage<unknown>();
  return {
    storage,
    actorContextStorage: storage,
    getActorContext: () => storage.getStore() as never,
    getActorContextOrThrow: () => {
      const ctx = storage.getStore();
      if (!ctx) throw new Error("ActorContext is required");
      return ctx;
    },
    withActorContext: <T>(ctx: unknown, fn: () => Promise<T>): Promise<T> =>
      storage.run(ctx, fn),
  };
});
vi.mock("@cinatra-ai/llm", () => orchestrationStub);
vi.mock("@cinatra-ai/llm/actor-context", () => orchestrationStub);

const agentBuilder = vi.hoisted(() => ({
  readPublishedAgentTemplates: vi.fn(),
  createAgentRun: vi.fn(async () => ({ id: "run-a", status: "queued" })),
  readAgentRunById: vi.fn(),
  readAgentTemplateById: vi.fn(),
  updateAgentRunA2ATaskId: vi.fn(async () => undefined),
  jsonSchemaToZod: vi.fn(),
}));
vi.mock("@cinatra/agent-builder", () => agentBuilder);

vi.mock("../streaming-bridge", () => ({
  publishRunEvent: vi.fn(async () => undefined),
}));

import { createInProcessA2AClient } from "../client";

const FRAME = {
  principalType: "HumanUser" as const,
  principalId: "user-1",
  organizationId: "org-A",
  authSource: "ui" as const,
  policyVersion: "v2",
  oboCeiling: { chain: ["anchor-1"] },
};

type CreatedRun = Record<string, unknown>;

async function buildClient(created: CreatedRun[]) {
  return createInProcessA2AClient({
    packageName: "pkg-a",
    enqueueJob: vi.fn(async () => undefined),
    pollIntervalMs: 1,
    pollTimeoutMs: 20,
    createRunWithAuthority: (async (input: CreatedRun) => {
      created.push(input);
      return { id: "run-a" };
    }) as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  agentBuilder.readPublishedAgentTemplates.mockResolvedValue([
    { id: "tpl_1", packageName: "pkg-a", name: "A" },
  ]);
  agentBuilder.readAgentTemplateById.mockResolvedValue({
    id: "tpl_1",
    inputSchema: {},
  });
  agentBuilder.readAgentRunById.mockResolvedValue({ status: "completed" });
});

describe("in-process dispatch — the frame survives to the executor", () => {
  it("carries orgId, runBy and parentOboCeiling from the ALS frame into the guarded creation contract", async () => {
    const created: CreatedRun[] = [];
    const client = await orchestrationStub.withActorContext(FRAME, async () =>
      buildClient(created),
    );

    await orchestrationStub.withActorContext(FRAME, async () =>
      client.sendMessage({ json: { q: "hi" } }),
    );

    expect(created).toHaveLength(1);
    // orgId — the run row's NOT NULL organization, read from the frame.
    expect(created[0].orgId).toBe("org-A");
    // runBy — audit attribution: WHO the run belongs to. Only stamped for a
    // HumanUser principal, which is exactly what the internal branch supplies.
    expect(created[0].runBy).toBe("user-1");
    // parentOboCeiling — the delegated-scope chain a child run composes onto.
    expect(created[0].parentOboCeiling).toEqual(FRAME.oboCeiling);
  });

  it("REFUSES the dispatch outside any frame — no run is created", async () => {
    const created: CreatedRun[] = [];
    const client = await orchestrationStub.withActorContext(FRAME, async () =>
      buildClient(created),
    );

    await expect(client.sendMessage({ json: { q: "hi" } })).rejects.toThrow(
      /no ActorContext frame is active/,
    );
    expect(created).toHaveLength(0);
  });
});
