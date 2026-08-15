/**
 * NO MODEL-AUTHORED RUN URL (cinatra#2729 defect 1).
 *
 * The only run link in a conversation used to be whatever the model wrote for
 * it, and what it wrote was `/agents/runs/<runId>` — an API path with no page
 * behind it, which 404s. Two pins hold the fix:
 *
 *   1. the dispatch wire offers no path to copy or complete, and
 *   2. the model directive forbids composing one at all.
 *
 * The link the reader actually gets is built by the chat card from the run
 * API's package name, pinned in `inline-agent-run-card-canonical-link.test.tsx`
 * against the same builder the notification writer uses.
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

describe("serverSideExplicitDispatch — no run path on the wire", () => {
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
    const raw = String(toolResult?.data.result);
    return {
      raw,
      result: JSON.parse(raw) as Record<string, unknown>,
    };
  }

  it("keeps the run id and status the chat already relied on", async () => {
    const { result } = await dispatch();

    expect(result.runId).toBe(RUN_ID);
    expect(result.status).toBe("pending_approval");
  });

  it("puts NO run path on the wire — not the canonical one, not a guessed one", async () => {
    const { result, raw } = await dispatch();

    expect(Object.keys(result).sort()).toEqual(["runId", "status"]);
    expect(raw).not.toContain("/agents/");
    expect(raw).not.toContain(buildAgentInstancePath(PACKAGE, RUN_ID));
  });
});

describe("the dispatch directive forbids a model-authored run URL", () => {
  it("names runHref as the only link the model may use", () => {
    const directive = detectExplicitDispatchDirective([
      { role: "user", content: `use ${PACKAGE} and draft a post` },
    ]);

    expect(directive).toContain("Never write a run URL yourself");
    expect(directive).toContain("404");
  });
});
