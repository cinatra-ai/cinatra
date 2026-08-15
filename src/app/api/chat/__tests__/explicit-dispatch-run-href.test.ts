/**
 * THE CHAT'S RUN LINK IS BUILT BY THE PLATFORM (cinatra#2729 defect 1).
 *
 * The dispatch result used to be `{ runId, status }`, so a model that wanted to
 * link the run had to compose a path — and it composed `/agents/runs/<runId>`,
 * an API path with no page behind it, which 404s. These pins state the two
 * halves of the fix:
 *
 *   1. the dispatch result carries `runHref`, and it EQUALS the canonical
 *      builder's output for the same package and run, and
 *   2. the model directive forbids writing a run URL at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgentInstancePath } from "@/lib/agent-url";

const mocks = vi.hoisted(() => ({
  safeEmit: vi.fn(async () => undefined),
  isPinActive: vi.fn(() => false),
  invokePrimitive: vi.fn(),
}));

vi.mock("@cinatra-ai/notifications/server", () => ({
  safeEmitAgentCreationProgress: mocks.safeEmit,
}));

vi.mock("@/lib/database", () => ({
  isAgentCreationPinActive: () => mocks.isPinActive(),
}));

vi.mock("@/lib/agent-run-readiness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-run-readiness")>()),
  assertAgentRunReadyByPackage: vi.fn(async () => null),
}));

vi.mock("@cinatra-ai/agents", () => ({
  preflightAgentCreation: vi.fn(),
  resolveRequiredCreationSkillIds: vi.fn(),
  createAgentBuilderPrimitiveHandlers: () => ({}),
  readPublishedAgentTemplates: vi.fn(async () => []),
  getAgentCreationFlowPackages: () => new Set<string>(),
}));

vi.mock("@cinatra-ai/mcp-client", () => ({
  createInProcessPrimitiveTransport: vi.fn(() => ({})),
  invokePrimitive: (...args: unknown[]) => mocks.invokePrimitive(...args),
}));

vi.mock("@cinatra-ai/llm", () => ({
  runDeterministicLlmTask: vi.fn(async () => ({ text: "{}" })),
}));

import { serverSideExplicitDispatch } from "../explicit-dispatch-server";
import { detectExplicitDispatchDirective } from "../explicit-dispatch";

const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";
const RUN_ID = "85bd2267-3f9a-4f0d-a1da-bb3a54f1a50d";

function makeSend(): {
  send: (event: string, data: Record<string, unknown>) => void;
  events: Array<{ event: string; data: Record<string, unknown> }>;
} {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  return { events, send: (event, data) => void events.push({ event, data }) };
}

function humanActor(): import("@/lib/authz/actor-context").ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-1",
    authSource: "ui",
    policyVersion: "test",
  };
}

beforeEach(() => {
  mocks.isPinActive.mockReset();
  mocks.isPinActive.mockReturnValue(false);
  mocks.invokePrimitive.mockReset();
  mocks.safeEmit.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serverSideExplicitDispatch — the run href on the wire", () => {
  async function dispatch() {
    mocks.invokePrimitive.mockResolvedValueOnce({
      runId: RUN_ID,
      status: "pending_approval",
    });
    const { send, events } = makeSend();
    await serverSideExplicitDispatch({
      packageName: PACKAGE,
      actor: humanActor(),
      send,
    });
    const toolResult = events.find((e) => e.event === "tool_result");
    return JSON.parse(String(toolResult?.data.result)) as {
      runId: string;
      status: string;
      runHref?: string;
    };
  }

  it("carries the CANONICAL path the shared builder produces", async () => {
    const result = await dispatch();

    expect(result.runHref).toBe(buildAgentInstancePath(PACKAGE, RUN_ID));
    expect(result.runHref).toBe(
      `/agents/cinatra-ai/blog-draft-writer-agent/${RUN_ID}`,
    );
  });

  it("never emits the API-shaped path the model used to guess", async () => {
    const result = await dispatch();

    expect(result.runHref).not.toBe(`/agents/runs/${RUN_ID}`);
    expect(result.runHref?.startsWith("/agents/runs/")).toBe(false);
  });

  it("keeps the run id and status the chat already relied on", async () => {
    const result = await dispatch();

    expect(result.runId).toBe(RUN_ID);
    expect(result.status).toBe("pending_approval");
  });
});

describe("the dispatch directive forbids a model-authored run URL", () => {
  it("names runHref as the only link the model may use", () => {
    const directive = detectExplicitDispatchDirective([
      { role: "user", content: `use ${PACKAGE} and draft a post` },
    ]);

    expect(directive).toContain("Never write a run URL yourself");
    expect(directive).toContain("runHref");
  });
});
