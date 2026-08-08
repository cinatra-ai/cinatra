/**
 * Unit proof for the unified `approvals_*` MCP tools (#1048), exercised THROUGH
 * the real registration + handler dispatch: the module is registered into a
 * capture server exactly as `src/lib/mcp-server.ts` does, and each captured
 * handler is invoked inside a real `mcpRequestContextStorage` frame — so the
 * viewer is resolved from CONTEXT, never from tool input.
 *
 * The `ApprovalSource` registry is mocked with controllable fake sources so the
 * federation logic (direction, per-source eligibility, unavailable-source
 * omission, soft-fail, `sourceId` targeting, `raw`-field non-leak, structured
 * decide refusals) is asserted without a DB. The REAL agent-source decide
 * PARITY (same helper the UI server action calls) is proven in the sibling
 * `approvals-mcp-agent-parity.test.ts`.
 *
 * A second block drives the coarse Posture-B boundary (`enforceMcpBoundary`)
 * against the `approvals_*` classifications added in `inventory-augment.ts`, so
 * a future misclassification (e.g. accidentally hard-gating list/get on an
 * admin permission, or making decide a read effect) fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mcpRequestContextStorage, type McpRequestContext } from "@cinatra-ai/mcp-server";
import type {
  ApprovalAction,
  ApprovalEnvelope,
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  Availability,
  DecideInput,
  DecideResult,
  Direction,
  FetchOpts,
} from "../sources/types";

// ── mutable fake registry (hoisted so the vi.mock factory can close over it) ──
const { registryArr } = vi.hoisted(() => ({ registryArr: [] as ApprovalSource[] }));
vi.mock("../sources/registry", () => ({ approvalSourceRegistry: registryArr }));

import { registerApprovalsPrimitives } from "../approvals-mcp";

// ── capture server (mirrors the registration in src/lib/mcp-server.ts) ────────
type Envelope = { content: unknown; structuredContent: Record<string, unknown> };
type Handler = (input: unknown) => Promise<Envelope>;

function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _cfg: unknown, h: Handler) => {
      handlers.set(name, h);
    },
  };
  registerApprovalsPrimitives(server as never);
  return handlers;
}
const handlers = captureHandlers();

async function call(
  tool: string,
  input: unknown,
  ctx: Partial<McpRequestContext>,
): Promise<Record<string, unknown>> {
  const h = handlers.get(tool);
  if (!h) throw new Error(`tool ${tool} not registered`);
  const res = await mcpRequestContextStorage.run(ctx as McpRequestContext, () => h(input));
  return res.structuredContent;
}

const adminCtx: Partial<McpRequestContext> = {
  userId: "u-admin",
  orgId: "org-1",
  platformRole: "platform_admin",
};
const memberCtx: Partial<McpRequestContext> = {
  userId: "u-member",
  orgId: "org-1",
  platformRole: "member",
};

const ISO = "2026-07-01T00:00:00.000Z";

function row(over: Partial<ApprovalRow> & { id: string; sourceId: string }): ApprovalRow {
  return {
    title: `title-${over.id}`,
    status: "proposed",
    createdAt: ISO,
    ...over,
  };
}

function readyEnvelope(rows: ApprovalRow[], actions: ApprovalAction[] = []): ApprovalEnvelope {
  return { availability: "ready", rows, actions };
}

/** Fake source; every hook defaults to a benign "ready + empty" so a test only
 *  states the behavior it cares about. */
function makeSource(over: Partial<ApprovalSource> & { id: string }): ApprovalSource {
  return {
    id: over.id,
    title: over.title ?? over.id,
    availability: over.availability ?? ((): Availability => "ready"),
    appliesTo: over.appliesTo ?? ((): boolean => true),
    fetchInbox: over.fetchInbox ?? (async () => readyEnvelope([])),
    fetchMine: over.fetchMine ?? (async () => readyEnvelope([])),
    counts: over.counts ?? (async () => ({ inbox: 0, mine: 0 })),
    rowRenderer: over.rowRenderer ?? (() => null),
    actions: over.actions ?? { decide: async () => ({ ok: true }) },
  } as ApprovalSource;
}

beforeEach(() => {
  registryArr.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
describe("approvals_list", () => {
  it("resolves the viewer from context, tags rows by source, and NEVER leaks the adapter-private `raw`", async () => {
    registryArr.push(
      makeSource({
        id: "A",
        title: "Source A",
        fetchInbox: async () =>
          readyEnvelope([
            row({
              id: "a1",
              sourceId: "A",
              version: "cas-1",
              // Secret adapter-private payload that MUST NOT be serialized.
              raw: { snapshotHash: "cas-1", secret: "do-not-leak" },
            }),
          ]),
      }),
    );

    const res = await call("approvals_list", { direction: "inbox" }, adminCtx);

    expect(res).toMatchObject({ ok: true, direction: "inbox" });
    const rows = res.rows as ApprovalRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "a1", sourceId: "A", version: "cas-1" });
    expect(rows[0]).not.toHaveProperty("raw");
    expect(res.sources).toEqual([{ sourceId: "A", title: "Source A", count: 1 }]);
    expect(res.unavailableSources).toEqual([]);
  });

  it("direction=mine dispatches fetchMine (not fetchInbox) and forwards a `status` history filter", async () => {
    const fetchInbox = vi.fn(async () => readyEnvelope([]));
    const fetchMine = vi.fn<(v: ApprovalViewer, opts?: FetchOpts) => Promise<ApprovalEnvelope>>(
      async () => readyEnvelope([row({ id: "m1", sourceId: "A" })]),
    );
    registryArr.push(makeSource({ id: "A", fetchInbox, fetchMine }));

    const res = await call("approvals_list", { direction: "mine", status: "all" }, memberCtx);

    expect(fetchInbox).not.toHaveBeenCalled();
    expect(fetchMine).toHaveBeenCalledTimes(1);
    expect(fetchMine.mock.calls[0][1]).toEqual({ status: "all" });
    expect((res.rows as ApprovalRow[])).toHaveLength(1);
  });

  it("OMITS a source the viewer can't participate in for this direction (appliesTo=false) — not an unavailable state", async () => {
    registryArr.push(
      makeSource({
        id: "A",
        appliesTo: (_v: ApprovalViewer, d: Direction) => d === "mine", // inbox not applicable
        fetchInbox: async () => readyEnvelope([row({ id: "a1", sourceId: "A" })]),
      }),
    );

    const res = await call("approvals_list", { direction: "inbox" }, memberCtx);

    expect(res.rows).toEqual([]);
    expect(res.sources).toEqual([]);
    expect(res.unavailableSources).toEqual([]); // omitted silently, NOT "unavailable"
  });

  it("reports a source whose coarse availability != ready as unavailable, without erroring the call", async () => {
    registryArr.push(makeSource({ id: "A", title: "A", availability: () => "not_connected" }));

    const res = await call("approvals_list", { direction: "inbox" }, memberCtx);

    expect(res).toMatchObject({ ok: true });
    expect(res.rows).toEqual([]);
    expect(res.unavailableSources).toEqual([
      { sourceId: "A", title: "A", availability: "not_connected" },
    ]);
  });

  it("reports a source whose fetch envelope is availability:error (with its display-safe message)", async () => {
    registryArr.push(
      makeSource({
        id: "A",
        title: "A",
        fetchInbox: async () => ({
          availability: "error",
          rows: [],
          actions: [],
          error: { message: "registry unreachable" },
        }),
      }),
    );

    const res = await call("approvals_list", { direction: "inbox" }, memberCtx);
    expect(res.unavailableSources).toEqual([
      { sourceId: "A", title: "A", availability: "error", message: "registry unreachable" },
    ]);
  });

  it("SOFT-FAILS a throwing source (sanitized message) and never blocks the others", async () => {
    registryArr.push(
      makeSource({
        id: "A",
        title: "A",
        fetchInbox: async () => {
          throw new Error("boom with a stack trace and secrets");
        },
      }),
      makeSource({
        id: "B",
        title: "B",
        fetchInbox: async () => readyEnvelope([row({ id: "b1", sourceId: "B" })]),
      }),
    );

    const res = await call("approvals_list", { direction: "inbox" }, memberCtx);

    expect(res).toMatchObject({ ok: true });
    expect((res.rows as ApprovalRow[]).map((r) => r.id)).toEqual(["b1"]);
    expect(res.unavailableSources).toEqual([
      { sourceId: "A", title: "A", availability: "error", message: "This source is temporarily unavailable." },
    ]);
    // The raw exception text must not leak into the response.
    expect(JSON.stringify(res)).not.toContain("secrets");
  });

  it("`sourceId` restricts the federation to a single source", async () => {
    registryArr.push(
      makeSource({ id: "A", fetchInbox: async () => readyEnvelope([row({ id: "a1", sourceId: "A" })]) }),
      makeSource({ id: "B", fetchInbox: async () => readyEnvelope([row({ id: "b1", sourceId: "B" })]) }),
    );

    const res = await call("approvals_list", { direction: "inbox", sourceId: "B" }, memberCtx);
    expect((res.rows as ApprovalRow[]).map((r) => r.id)).toEqual(["b1"]);
    expect(res.sources).toEqual([{ sourceId: "B", title: "B", count: 1 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("approvals_get", () => {
  it("returns the item + public actions + version; strips `raw`", async () => {
    const actions: ApprovalAction[] = [
      { id: "approve", label: "Approve", enforcement: "local" },
      { id: "reject", label: "Reject", intent: "destructive", enforcement: "local", requiresReason: true },
    ];
    registryArr.push(
      makeSource({
        id: "A",
        fetchInbox: async () =>
          readyEnvelope(
            [row({ id: "a1", sourceId: "A", version: "cas-9", raw: { secret: "no" } })],
            actions,
          ),
      }),
    );

    const res = await call("approvals_get", { sourceId: "A", id: "a1" }, adminCtx);

    expect(res).toMatchObject({ ok: true, sourceId: "A", availability: "ready" });
    expect(res.item).toMatchObject({ id: "a1", version: "cas-9" });
    expect(res.item).not.toHaveProperty("raw");
    expect(res.actions).toEqual([
      { id: "approve", label: "Approve", enforcement: "local" },
      { id: "reject", label: "Reject", enforcement: "local", intent: "destructive", requiresReason: true },
    ]);
  });

  it("unknown sourceId → unknown_source (404)", async () => {
    const res = await call("approvals_get", { sourceId: "nope", id: "x" }, adminCtx);
    expect(res).toMatchObject({ ok: false, error: { code: "unknown_source", httpStatus: 404 } });
  });

  it("a MISMATCHED sourceId (id belongs to a different source) → not_found (404)", async () => {
    registryArr.push(
      makeSource({ id: "A", fetchInbox: async () => readyEnvelope([row({ id: "a1", sourceId: "A" })]) }),
      makeSource({ id: "B", fetchInbox: async () => readyEnvelope([row({ id: "b1", sourceId: "B" })]) }),
    );
    // id b1 exists — but NOT in source A. Must not be routable to the wrong source.
    const res = await call("approvals_get", { sourceId: "A", id: "b1" }, adminCtx);
    expect(res).toMatchObject({ ok: false, error: { code: "not_found", httpStatus: 404 } });
  });

  it("an unavailable source → source_unavailable (carries the availability)", async () => {
    registryArr.push(makeSource({ id: "A", availability: () => "not_configured" }));
    const res = await call("approvals_get", { sourceId: "A", id: "a1" }, adminCtx);
    expect(res).toMatchObject({
      ok: false,
      error: { code: "source_unavailable", availability: "not_configured" },
    });
  });

  it("only searches the directions the viewer participates in (an ineligible row is not_found, never leaked)", async () => {
    const fetchInbox = vi.fn(async () => readyEnvelope([row({ id: "a1", sourceId: "A" })]));
    registryArr.push(
      makeSource({
        id: "A",
        appliesTo: (_v, d) => d === "mine", // inbox is NOT applicable to this viewer
        fetchInbox,
        fetchMine: async () => readyEnvelope([]),
      }),
    );
    const res = await call("approvals_get", { sourceId: "A", id: "a1" }, memberCtx);
    expect(fetchInbox).not.toHaveBeenCalled(); // inbox direction skipped by appliesTo
    expect(res).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("approvals_decide", () => {
  it("delegates to the source's own decide helper with the CONTEXT viewer + full DecideInput, and returns ok", async () => {
    const decide = vi.fn<(input: DecideInput, viewer: ApprovalViewer) => Promise<DecideResult>>(
      async () => ({
        ok: true,
        row: row({ id: "a1", sourceId: "A", status: "approved", raw: { secret: "no" } }),
      }),
    );
    registryArr.push(makeSource({ id: "A", actions: { decide } }));

    const res = await call(
      "approvals_decide",
      { sourceId: "A", id: "a1", decision: "approve", reason: "lgtm", expectedVersion: "cas-1" },
      adminCtx,
    );

    expect(decide).toHaveBeenCalledTimes(1);
    const [input, viewer] = decide.mock.calls[0];
    expect(input).toEqual({ rowId: "a1", action: "approve", reason: "lgtm", expectedVersion: "cas-1" });
    // Viewer comes from the MCP request CONTEXT, never from tool input.
    expect(viewer).toEqual({ userId: "u-admin", orgId: "org-1", isAdmin: true });
    expect(res).toMatchObject({ ok: true, sourceId: "A", id: "a1", decision: "approve" });
    expect(res.item).toMatchObject({ id: "a1", status: "approved" });
    expect(res.item).not.toHaveProperty("raw");
  });

  it("a structured refusal (SoD / conflict) is surfaced readably, NOT thrown", async () => {
    const decide = vi.fn(
      async (): Promise<DecideResult> => ({
        ok: false,
        code: "stale_snapshot",
        kind: "refused",
        httpStatus: 409,
        message: "The proposal changed since you viewed it — refresh and try again.",
      }),
    );
    registryArr.push(makeSource({ id: "A", actions: { decide } }));

    const res = await call(
      "approvals_decide",
      { sourceId: "A", id: "a1", decision: "approve", expectedVersion: "cas-1" },
      adminCtx,
    );
    expect(res).toMatchObject({
      ok: false,
      error: { code: "stale_snapshot", kind: "refused", httpStatus: 409 },
    });
  });

  it("unknown sourceId → unknown_source (a decision is NEVER routed to a guessed source)", async () => {
    const res = await call(
      "approvals_decide",
      { sourceId: "nope", id: "a1", decision: "approve", expectedVersion: "x" },
      adminCtx,
    );
    expect(res).toMatchObject({ ok: false, error: { code: "unknown_source" } });
  });

  it("omits an undefined reason and resolves isAdmin=false for a non-admin viewer", async () => {
    const decide = vi.fn<(input: DecideInput, viewer: ApprovalViewer) => Promise<DecideResult>>(
      async () => ({ ok: true }),
    );
    registryArr.push(makeSource({ id: "A", actions: { decide } }));

    await call(
      "approvals_decide",
      { sourceId: "A", id: "a1", decision: "approve", expectedVersion: "cas-1" },
      memberCtx,
    );
    const [input, viewer] = decide.mock.calls[0];
    expect(input).not.toHaveProperty("reason");
    expect(viewer.isAdmin).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("resolveViewer — fail-closed", () => {
  it("an org-less / userless caller cannot list, get, or decide (throws, not a silent empty)", async () => {
    registryArr.push(makeSource({ id: "A" }));
    await expect(call("approvals_list", { direction: "inbox" }, {})).rejects.toThrow(/fail-closed/);
    await expect(call("approvals_get", { sourceId: "A", id: "a1" }, { userId: "u" })).rejects.toThrow(
      /fail-closed/,
    );
    await expect(
      call("approvals_decide", { sourceId: "A", id: "a1", decision: "approve" }, { orgId: "o" }),
    ).rejects.toThrow(/fail-closed/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coarse Posture-B boundary classification (inventory-augment.ts) driven through
// the REAL enforceMcpBoundary. list/get are member-passable READS (per-source
// eligibility filters the content); decide is an ADMIN-effect membership gate
// that DEFERS the real admin/SoD check to the handler.
describe("approvals_* coarse boundary classification", () => {
  const bMember = () => ({ orgId: "org-1", userId: "u-member", platformRole: undefined as never });
  const bAdmin = () => ({ orgId: "org-1", userId: "u-admin", platformRole: "platform_admin" as const });

  beforeEach(async () => {
    const audit = await import("@/lib/authz/audit");
    vi.spyOn(audit, "logAuditEvent").mockResolvedValue(undefined);
  });

  it("approvals_list — org member allowed (agent::list, read effect hard-enforced; member holds agent.list)", async () => {
    const { enforceMcpBoundary } = await import("@/lib/authz/mcp-boundary");
    const d = await enforceMcpBoundary({ primitiveName: "approvals_list", ctx: bMember(), delegatedRestricted: false });
    expect(d.allowed).toBe(true);
  });

  it("approvals_get — org member allowed (agent::read; member holds agent.read)", async () => {
    const { enforceMcpBoundary } = await import("@/lib/authz/mcp-boundary");
    const d = await enforceMcpBoundary({ primitiveName: "approvals_get", ctx: bMember(), delegatedRestricted: false });
    expect(d.allowed).toBe(true);
  });

  it("approvals_decide — member passes the membership gate; the real admin/SoD check is DEFERRED to the handler (agent::share, admin effect)", async () => {
    const audit = await import("@/lib/authz/audit");
    const spy = vi.spyOn(audit, "logAuditEvent").mockResolvedValue(undefined);
    const { enforceMcpBoundary } = await import("@/lib/authz/mcp-boundary");
    const d = await enforceMcpBoundary({ primitiveName: "approvals_decide", ctx: bMember(), delegatedRestricted: false });
    expect(d.allowed).toBe(true);
    // Admin effect ⇒ NOT hard-enforced as a read; the specific permission is
    // audited-but-deferred (member does not hold agent.share).
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "allowed",
        metadata: expect.objectContaining({ effect: "admin", deferredToHandler: true }),
      }),
    );
  });

  it("approvals_decide — an unauthenticated / org-less caller is BLOCKED (deny-by-default)", async () => {
    const { enforceMcpBoundary } = await import("@/lib/authz/mcp-boundary");
    const d = await enforceMcpBoundary({
      primitiveName: "approvals_decide",
      ctx: { orgId: null, userId: null, platformRole: undefined as never },
      delegatedRestricted: false,
    });
    expect(d).toMatchObject({ allowed: false, reason: "not_org_member", shouldBlock: true });
  });

  it("approvals_list — platform_admin allowed unconditionally", async () => {
    const { enforceMcpBoundary } = await import("@/lib/authz/mcp-boundary");
    const d = await enforceMcpBoundary({ primitiveName: "approvals_list", ctx: bAdmin(), delegatedRestricted: false });
    expect(d.allowed).toBe(true);
  });
});
