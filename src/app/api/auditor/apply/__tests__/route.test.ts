/**
 * Regression coverage: POST /api/auditor/apply bridge run-binding.
 *
 * A bridge-token holder must NOT be able to act on an arbitrary agent_run_id.
 * The body-selected id is bound to the auth-injected X-Cinatra-A2A-Context-Id
 * (the run actually executing this callback). Mismatch / missing header => 403,
 * BEFORE any run load or patch application.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const bridge = vi.hoisted(() => ({ authed: true }));
vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: () => bridge.authed,
}));

vi.mock("@/lib/auth-session", () => ({
  isPlatformAdmin: () => false,
  requireAuthSession: vi.fn(async () => null),
}));

const store = vi.hoisted(() => ({
  readAgentRunByContextId: vi.fn(),
  readAgentRunById: vi.fn(),
  readRunCoOwners: vi.fn(async () => []),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: store.readAgentRunById,
  readRunCoOwners: store.readRunCoOwners,
  readAgentRunByContextId: store.readAgentRunByContextId,
}));

vi.mock("@cinatra-ai/agents/schema", () => ({ auditEvents: { reviewTaskId: "reviewTaskId", eventType: "eventType", payload: "payload" } }));
vi.mock("@cinatra-ai/agents/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [] }) }),
  },
}));

vi.mock("@cinatra-ai/agents/auditor-apply", async () => {
  const { z } = await import("zod");
  return {
    applyAuditorPatches: vi.fn((data: unknown) => data),
    AuditorApplyError: class extends Error {},
    SuggestionPatchSchema: z.object({
      id: z.string(),
      fieldPath: z.string(),
      op: z.string(),
      value: z.string(),
      message: z.string(),
    }),
  };
});

import { POST } from "../route";

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auditor/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = {
  agent_run_id: "run-1",
  data: {},
  reviewResult: JSON.stringify({ acceptedIds: [], dismissedIds: [] }),
};

describe("POST /api/auditor/apply — bridge run-binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bridge.authed = true;
    store.readRunCoOwners.mockResolvedValue([]);
  });

  it("403 when bridge-authed but the context-id header is absent", async () => {
    const res = await POST(makeReq(validBody));
    expect(res.status).toBe(403);
    expect(store.readAgentRunById).not.toHaveBeenCalled();
  });

  it("403 when the body agent_run_id does not match the executing (context-resolved) run", async () => {
    store.readAgentRunByContextId.mockResolvedValue({ id: "attacker-run" });
    const res = await POST(
      makeReq(validBody, { "x-cinatra-a2a-context-id": "ctx-attacker" }),
    );
    expect(res.status).toBe(403);
    expect(store.readAgentRunById).not.toHaveBeenCalled();
  });

  it("proceeds past the binding when context id matches the body run id", async () => {
    store.readAgentRunByContextId.mockResolvedValue({ id: "run-1" });
    store.readAgentRunById.mockResolvedValue({ id: "run-1", runBy: "owner" });
    const res = await POST(
      makeReq(validBody, { "x-cinatra-a2a-context-id": "ctx-1" }),
    );
    // Binding passed -> run load happened -> apply runs with empty acceptedIds.
    expect(store.readAgentRunById).toHaveBeenCalledWith("run-1");
    expect(res.status).toBe(200);
  });
});
