/**
 * REAL-dispatch PARITY proof for `approvals_decide` against the agent-creation-
 * requests decision path.
 *
 * The whole point of the unified tools is that a decision executes at its source
 * through the SAME non-redirecting helper the UI server action uses — there is
 * no parallel decision path. The agent source wires `actions.decide` to
 * `decideAgentCreationRequest` (see sources/agent-creation-requests.ts); here the
 * registered source's `actions.decide` is that SAME real helper, which delegates
 * to the SAME audited `agent_creation_request_decide` primitive the UI calls. So
 * authorization, the separation-of-duties self-approval guard, the edit-after-view
 * (CAS) guard, and the audit write are the UI's, not a copy.
 *
 * Only the audited primitive is mocked (identically to decision-helpers.test.ts),
 * so no DB is needed; we assert the EXACT payload the primitive receives and that
 * its refusals/guards surface as structured MCP refusals. (The heavier
 * agent-source rowRenderer/fetch UI graph is irrelevant to decide parity and is
 * covered by agent-creation-requests-source.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";

const decideHandler = vi.fn();
vi.mock("@cinatra-ai/agents/mcp-handlers", () => ({
  createAgentBuilderPrimitiveHandlers: () => ({
    agent_creation_request_decide: decideHandler,
  }),
}));

// Register a single source whose `actions.decide` is the REAL shared helper the
// agent source uses (decideAgentCreationRequest) — proving MCP decide dispatch
// routes to the genuine per-source decision path. The async factory pulls only
// the light decision-helper (no UI/DB graph).
vi.mock("../sources/registry", async () => {
  const { decideAgentCreationRequest } = await import("../decision-helpers");
  const { AGENT_SOURCE_ID } = await import("../resolve-active-view");
  const source = {
    id: AGENT_SOURCE_ID,
    title: "Agent creation requests",
    availability: () => "ready" as const,
    appliesTo: () => true,
    fetchInbox: async () => ({ availability: "ready" as const, rows: [], actions: [] }),
    fetchMine: async () => ({ availability: "ready" as const, rows: [], actions: [] }),
    counts: async () => ({ inbox: 0, mine: 0 }),
    rowRenderer: () => null,
    actions: { decide: decideAgentCreationRequest },
  };
  return { approvalSourceRegistry: [source] };
});

import { registerApprovalsPrimitives } from "../approvals-mcp";
import { AGENT_SOURCE_ID } from "../resolve-active-view";

type Envelope = { content: unknown; structuredContent: Record<string, unknown> };
type Handler = (input: unknown) => Promise<Envelope>;

function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _cfg: unknown, h: Handler) => handlers.set(name, h),
  };
  registerApprovalsPrimitives(server as never);
  return handlers;
}
const handlers = captureHandlers();

async function decide(input: unknown, ctx: Partial<McpRequestContext>): Promise<Record<string, unknown>> {
  const h = handlers.get("approvals_decide")!;
  const res = await mcpRequestContextStorage.run(ctx as McpRequestContext, () => h(input));
  return res.structuredContent;
}

const admin: Partial<McpRequestContext> = { userId: "u-admin", orgId: "org-1", platformRole: "platform_admin" };
const member: Partial<McpRequestContext> = { userId: "u-member", orgId: "org-1", platformRole: "member" };

beforeEach(() => decideHandler.mockReset());

describe("approvals_decide → REAL agent-creation-requests decide helper (UI parity)", () => {
  it("an approve round-trips to the audited primitive with the UI-identical payload (admin actor + CAS token)", async () => {
    decideHandler.mockResolvedValue({}); // primitive success (no `error` field)

    const res = await decide(
      { sourceId: AGENT_SOURCE_ID, id: "req-1", decision: "approve", expectedVersion: "hash-1" },
      admin,
    );

    expect(decideHandler).toHaveBeenCalledTimes(1);
    expect(decideHandler.mock.calls[0][0]).toMatchObject({
      primitiveName: "agent_creation_request_decide",
      input: { id: "req-1", decision: "approve", expectedSnapshotHash: "hash-1" },
      actor: {
        actorType: "human",
        source: "ui",
        userId: "u-admin",
        organizationId: "org-1",
        platformRole: "platform_admin",
      },
      mode: "deterministic",
    });
    expect(res).toMatchObject({ ok: true, sourceId: AGENT_SOURCE_ID, id: "req-1", decision: "approve" });
  });

  it("a reject carries the reason through to the primitive", async () => {
    decideHandler.mockResolvedValue({});
    await decide(
      { sourceId: AGENT_SOURCE_ID, id: "req-1", decision: "reject", reason: "duplicate", expectedVersion: "h" },
      admin,
    );
    expect(decideHandler.mock.calls[0][0].input).toMatchObject({ decision: "reject", reason: "duplicate" });
  });

  it("a MISSING CAS token is refused `version_required` and the primitive is NEVER called (edit-after-view guard preserved)", async () => {
    const res = await decide({ sourceId: AGENT_SOURCE_ID, id: "req-1", decision: "approve" }, admin);
    expect(decideHandler).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, error: { code: "version_required", kind: "refused" } });
  });

  it("a reject WITHOUT a reason is refused by the shared helper before the primitive", async () => {
    const res = await decide(
      { sourceId: AGENT_SOURCE_ID, id: "req-1", decision: "reject", expectedVersion: "h" },
      admin,
    );
    expect(decideHandler).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, error: { code: "reason_required", kind: "refused" } });
  });

  it("a primitive self-approval refusal surfaces as a structured MCP refusal (kind=refused)", async () => {
    decideHandler.mockResolvedValue({
      error: "self-approval is disallowed (set connector_config.agent_creation.allowSelfApproval=true to override).",
    });
    const res = await decide(
      { sourceId: AGENT_SOURCE_ID, id: "req-1", decision: "approve", expectedVersion: "h" },
      admin,
    );
    expect(res).toMatchObject({ ok: false, error: { code: "self_approval_forbidden", kind: "refused" } });
  });

  it("a non-admin viewer claims only 'member' at the primitive (the primitive re-checks; the MCP layer never widens authority)", async () => {
    decideHandler.mockResolvedValue({});
    await decide(
      { sourceId: AGENT_SOURCE_ID, id: "req-1", decision: "approve", expectedVersion: "h" },
      member,
    );
    expect(decideHandler.mock.calls[0][0].actor.platformRole).toBe("member");
  });
});
