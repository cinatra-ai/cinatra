/**
 * POST /api/auditor/exclude — the post-resume dismissed-guidance companion
 * (cinatra#1625, #1794).
 *
 * Asserts: the reviewResult envelope is JSON-parsed for excludedPromptIds; an
 * empty set is an idempotent no-op (no primitive call); a non-empty set invokes
 * the run-bound agent_run_hitl_prompts_exclude primitive inside the verified
 * run-scope frame.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const bridge = vi.hoisted(() => ({ authed: true }));
vi.mock("@/lib/wayflow-bridge-auth", () => ({ isAuthorizedBridgeRequest: () => bridge.authed }));
vi.mock("@/lib/auth-session", () => ({
  isPlatformAdmin: () => false,
  requireAuthSession: vi.fn(async () => null),
}));
vi.mock("@/lib/authz/bridge-run-binding", () => ({
  bindBridgeRunId: vi.fn(async () => ({ ok: true, runId: "run-1" })),
}));
vi.mock("@/lib/authz/build-actor-context-from-run", () => ({
  buildActorContextFromRun: vi.fn(async () => ({
    principalType: "HumanUser",
    principalId: "u1",
    organizationId: "o1",
    platformRole: null,
  })),
}));

const store = vi.hoisted(() => ({
  readAgentRunById: vi.fn(async () => ({ id: "run-1", runBy: "u1", orgId: "o1" })),
  readRunCoOwners: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: store.readAgentRunById,
  readRunCoOwners: store.readRunCoOwners,
}));

const capture = vi.hoisted(() => ({ frame: null as unknown, excludeInput: null as unknown }));
const handler = vi.hoisted(() => vi.fn(async (req: { input: unknown }) => {
  capture.excludeInput = req.input;
  return { applied: 2, requested: 2 };
}));
vi.mock("@/lib/primitive-handlers", () => ({
  collectAllPrimitiveHandlers: vi.fn(async () => ({ agent_run_hitl_prompts_exclude: handler })),
}));
vi.mock("@cinatra-ai/mcp-server", () => ({
  mcpRequestContextStorage: {
    run: (frame: unknown, fn: () => unknown) => {
      capture.frame = frame;
      return fn();
    },
  },
}));
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_c: unknown, fn: () => unknown) => fn(),
}));

import { POST } from "../route";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/auditor/exclude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
const env = (excluded: string[]) =>
  JSON.stringify({ acceptedPatchIds: [], dismissedPatchIds: [], excludedPromptIds: excluded });

beforeEach(() => {
  vi.clearAllMocks();
  bridge.authed = true;
  capture.frame = null;
  capture.excludeInput = null;
});

describe("POST /api/auditor/exclude", () => {
  it("no-op (applied:0) with no primitive call when excludedPromptIds is empty", async () => {
    const res = await POST(makeReq({ agent_run_id: "run-1", reviewResult: env([]) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 0 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes the run-bound exclude primitive with the verified run scope", async () => {
    const res = await POST(makeReq({ agent_run_id: "run-1", reviewResult: env(["a", "b"]) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ applied: 2 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(capture.excludeInput).toEqual({ ids: ["a", "b"] });
    expect((capture.frame as { verifiedRunScopeId?: string }).verifiedRunScopeId).toBe("run-1");
  });

  it("rejects a malformed reviewResult envelope (400)", async () => {
    const res = await POST(makeReq({ agent_run_id: "run-1", reviewResult: "nope" }));
    expect(res.status).toBe(400);
  });
});
