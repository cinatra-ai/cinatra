import { describe, it, expect, vi } from "vitest";

import type { ApprovalEnvelope, ApprovalRow, ApprovalSource, DecideInput } from "../sources/types";

// ---------------------------------------------------------------------------
// Real registered-handler dispatch test. Drives the ACTUAL tool callbacks
// registered by `registerApprovalsPrimitives` (schema parse → viewer resolution
// from mcpRequestContextStorage → core → MCP envelope), with the ApprovalSource
// registry mocked so no DB / marketplace client is needed. This is the same
// callback the live MCP `tools/call` transport invokes.
//
// The fake source + capture state live in a `vi.hoisted` block so the hoisted
// `vi.mock("../sources/registry")` factory can reference them safely.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const state: { lastDecide?: { input: DecideInput; isAdmin: boolean } } = {};
  const ready = (rows: ApprovalRow[]): ApprovalEnvelope => ({
    availability: "ready",
    rows,
    actions: [{ id: "approve", label: "Approve", enforcement: "local" }],
  });
  const r = (id: string): ApprovalRow => ({
    id,
    sourceId: "agent-creation-requests",
    title: `T-${id}`,
    status: "pending",
    createdAt: "2026-07-09T00:00:00Z",
    version: "snap-1",
    // ADAPTER-PRIVATE — must be stripped by the MCP tools.
    raw: { snapshotHash: "snap-1" },
  });
  // Admin-only inbox source: proves viewer.isAdmin threads through from
  // platformRole, and carries a version token + a private `raw` (proves raw is
  // stripped end-to-end).
  const adminInboxSource: ApprovalSource = {
    id: "agent-creation-requests",
    title: "Agent creation requests",
    availability: () => "ready",
    appliesTo: (viewer, direction) => (direction === "mine" ? true : viewer.isAdmin),
    fetchInbox: async (viewer) => (viewer.isAdmin ? ready([r("row-1")]) : ready([])),
    fetchMine: async () => ready([]),
    counts: async () => ({ inbox: 0, mine: 0 }),
    rowRenderer: () => null,
    actions: {
      decide: async (input, viewer) => {
        state.lastDecide = { input, isAdmin: viewer.isAdmin };
        return { ok: true };
      },
    },
  };
  return { state, adminInboxSource };
});

vi.mock("../sources/registry", () => ({
  approvalSourceRegistry: [h.adminInboxSource],
  availableSources: async () => [h.adminInboxSource],
}));

import { registerApprovalsPrimitives, APPROVALS_TOOL_META } from "../mcp";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

type Handler = (input: unknown) => Promise<{ content: unknown; structuredContent: Record<string, unknown> }>;

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as never;
  registerApprovalsPrimitives(server);
  return handlers;
}

const ADMIN_CTX = { userId: "admin1", orgId: "org1", platformRole: "platform_admin" as const };
const MEMBER_CTX = { userId: "mem1", orgId: "org1", platformRole: "member" as const };

function callWith<T>(ctx: unknown, fn: () => Promise<T>): Promise<T> {
  return mcpRequestContextStorage.run(ctx as never, fn);
}

describe("approvals_* registered dispatch", () => {
  it("registers exactly the three tools with metadata", () => {
    const handlers = register();
    expect([...handlers.keys()].sort()).toEqual(["approvals_decide", "approvals_get", "approvals_list"]);
    expect(Object.keys(APPROVALS_TOOL_META).sort()).toEqual(["approvals_decide", "approvals_get", "approvals_list"]);
  });

  it("approvals_list resolves the admin viewer from platformRole and returns the MCP envelope (raw stripped, version surfaced)", async () => {
    const handlers = register();
    const out = await callWith(ADMIN_CTX, () => handlers.get("approvals_list")!({ direction: "inbox" }));
    expect(Array.isArray((out as { content: unknown[] }).content)).toBe(true);
    const sc = out.structuredContent as { sources: Array<{ sourceId: string; rows: Array<Record<string, unknown>> }>; totalCount: number };
    expect(sc.sources).toHaveLength(1);
    expect(sc.totalCount).toBe(1);
    const item = sc.sources[0].rows[0];
    expect(item.version).toBe("snap-1");
    expect("raw" in item).toBe(false);
  });

  it("approvals_list threads a non-admin viewer (admin-only inbox section is filtered out)", async () => {
    const handlers = register();
    const out = await callWith(MEMBER_CTX, () => handlers.get("approvals_list")!({ direction: "inbox" }));
    const sc = out.structuredContent as { sources: unknown[]; totalCount: number };
    expect(sc.sources).toEqual([]);
    expect(sc.totalCount).toBe(0);
  });

  it("approvals_get returns a single item with its direction", async () => {
    const handlers = register();
    const out = await callWith(ADMIN_CTX, () => handlers.get("approvals_get")!({ sourceId: "agent-creation-requests", id: "row-1" }));
    const sc = out.structuredContent as { ok: boolean; item?: { id: string; direction: string; version?: string } };
    expect(sc.ok).toBe(true);
    expect(sc.item).toMatchObject({ id: "row-1", direction: "inbox", version: "snap-1" });
  });

  it("approvals_decide routes to the source helper, forwarding decision + expectedVersion, with isAdmin from platformRole", async () => {
    const handlers = register();
    h.state.lastDecide = undefined;
    const out = await callWith(ADMIN_CTX, () =>
      handlers.get("approvals_decide")!({ sourceId: "agent-creation-requests", id: "row-1", decision: "approve", expectedVersion: "snap-1" }),
    );
    expect(out.structuredContent).toMatchObject({ ok: true });
    expect(h.state.lastDecide).toEqual({ input: { rowId: "row-1", action: "approve", expectedVersion: "snap-1" }, isAdmin: true });
  });

  it("approvals_decide rejects an unknown sourceId as a structured refusal", async () => {
    const handlers = register();
    const out = await callWith(ADMIN_CTX, () =>
      handlers.get("approvals_decide")!({ sourceId: "does-not-exist", id: "x", decision: "approve" }),
    );
    expect(out.structuredContent).toMatchObject({ ok: false, code: "unknown_source" });
  });

  it("fails closed when there is no active organization (org-less caller)", async () => {
    const handlers = register();
    await expect(callWith({ userId: "u", orgId: null }, () => handlers.get("approvals_list")!({ direction: "inbox" }))).rejects.toThrow(
      /no active organization/i,
    );
  });

  it("rejects a malformed input via the zod schema", async () => {
    const handlers = register();
    await expect(callWith(ADMIN_CTX, () => handlers.get("approvals_list")!({ direction: "sideways" }))).rejects.toThrow();
  });
});
