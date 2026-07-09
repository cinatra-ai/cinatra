import { describe, it, expect } from "vitest";

import {
  collectApprovals,
  decideApproval,
  getApprovalItem,
} from "../mcp-core";
import type {
  ApprovalEnvelope,
  ApprovalRow,
  ApprovalSource,
  ApprovalViewer,
  DecideInput,
  DecideResult,
  Direction,
} from "../sources/types";

// ---------------------------------------------------------------------------
// Pure-core tests for the approvals_* MCP tools. No DB / server-only / network:
// fake ApprovalSources drive every branch (direction + viewer eligibility, the
// unavailable/omit resilience model, get-by-id precedence, decide routing +
// unknown-source rejection, and the CAS `expectedVersion` round-trip guard).
// ---------------------------------------------------------------------------

const VIEWER: ApprovalViewer = { userId: "u1", orgId: "o1", isAdmin: true };
const NON_ADMIN: ApprovalViewer = { userId: "u2", orgId: "o1", isAdmin: false };

function row(id: string, sourceId: string, extra: Partial<ApprovalRow> = {}): ApprovalRow {
  return { id, sourceId, title: `T-${id}`, status: "pending", createdAt: "2026-07-09T00:00:00Z", ...extra };
}

function ready(rows: ApprovalRow[]): ApprovalEnvelope {
  return {
    availability: "ready",
    rows,
    actions: [
      { id: "approve", label: "Approve", enforcement: "local" },
      { id: "reject", label: "Reject", intent: "destructive", enforcement: "local", requiresReason: true },
    ],
  };
}

interface FakeOpts {
  id: string;
  title?: string;
  group?: string;
  appliesTo?: (viewer: ApprovalViewer, direction: Direction) => boolean;
  availability?: ApprovalSource["availability"];
  sectionConfigured?: ApprovalSource["sectionConfigured"];
  inbox?: () => Promise<ApprovalEnvelope>;
  mine?: () => Promise<ApprovalEnvelope>;
  decide?: (input: DecideInput, viewer: ApprovalViewer) => Promise<DecideResult>;
}

function fakeSource(o: FakeOpts): ApprovalSource {
  return {
    id: o.id,
    title: o.title ?? o.id,
    ...(o.group ? { group: o.group } : {}),
    availability: o.availability ?? (() => "ready"),
    ...(o.sectionConfigured ? { sectionConfigured: o.sectionConfigured } : {}),
    appliesTo: o.appliesTo ?? (() => true),
    fetchInbox: o.inbox ?? (async () => ready([])),
    fetchMine: o.mine ?? (async () => ready([])),
    counts: async () => ({ inbox: 0, mine: 0 }),
    rowRenderer: () => null,
    actions: {
      decide:
        o.decide ??
        (async () => ({ ok: true }) as DecideResult),
    },
  };
}

describe("collectApprovals", () => {
  it("federates ready sources for a direction, tagging rows + per-source counts, and totals", async () => {
    const a = fakeSource({ id: "a", inbox: async () => ready([row("1", "a"), row("2", "a")]) });
    const b = fakeSource({ id: "b", inbox: async () => ready([row("3", "b")]) });
    const res = await collectApprovals([a, b], VIEWER, "inbox");
    expect(res.direction).toBe("inbox");
    expect(res.sources.map((s) => s.sourceId)).toEqual(["a", "b"]);
    expect(res.sources[0]).toMatchObject({ sourceId: "a", count: 2 });
    expect(res.sources[1]).toMatchObject({ sourceId: "b", count: 1 });
    expect(res.totalCount).toBe(3);
    expect(res.unavailableSources).toEqual([]);
  });

  it("respects appliesTo (direction + viewer eligibility): a mine-only / admin-only section is filtered out", async () => {
    // inbox is admin-only; mine is anyone.
    const src = fakeSource({
      id: "agentish",
      appliesTo: (viewer, direction) => (direction === "mine" ? true : viewer.isAdmin),
      inbox: async () => ready([row("x", "agentish")]),
      mine: async () => ready([row("y", "agentish")]),
    });
    const asNonAdminInbox = await collectApprovals([src], NON_ADMIN, "inbox");
    expect(asNonAdminInbox.sources).toEqual([]);
    expect(asNonAdminInbox.unavailableSources).toEqual([]); // not applicable ≠ unavailable
    const asNonAdminMine = await collectApprovals([src], NON_ADMIN, "mine");
    expect(asNonAdminMine.sources.map((s) => s.sourceId)).toEqual(["agentish"]);
  });

  it("omits a not_connected / not_configured / errored source into unavailableSources WITHOUT erroring the call", async () => {
    const connected = fakeSource({ id: "ok", inbox: async () => ready([row("1", "ok")]) });
    const notConnected = fakeSource({ id: "nc", availability: () => "not_connected" });
    const notConfigured = fakeSource({ id: "ncfg", sectionConfigured: () => false });
    const errored = fakeSource({
      id: "err",
      inbox: async () => ({ availability: "error", rows: [], actions: [], error: { message: "remote 500", retryable: true } }),
    });
    const res = await collectApprovals([connected, notConnected, notConfigured, errored], VIEWER, "inbox");
    expect(res.sources.map((s) => s.sourceId)).toEqual(["ok"]);
    expect(res.unavailableSources).toEqual([
      { sourceId: "nc", title: "nc", availability: "not_connected" },
      { sourceId: "ncfg", title: "ncfg", availability: "not_configured" },
      { sourceId: "err", title: "err", availability: "error", reason: "remote 500" },
    ]);
  });

  it("a THROWING source is reported as error and NEVER blocks a sibling local section", async () => {
    const boom = fakeSource({
      id: "boom",
      inbox: async () => {
        throw new Error("kaboom");
      },
    });
    const local = fakeSource({ id: "local", inbox: async () => ready([row("1", "local")]) });
    const res = await collectApprovals([boom, local], VIEWER, "inbox");
    expect(res.sources.map((s) => s.sourceId)).toEqual(["local"]); // sibling survived
    expect(res.unavailableSources).toEqual([{ sourceId: "boom", title: "boom", availability: "error", reason: "kaboom" }]);
  });

  it("a throwing coarse availability() is guarded (never throws the whole call)", async () => {
    const bad = fakeSource({
      id: "bad",
      availability: () => {
        throw new Error("avail-throw");
      },
    });
    const res = await collectApprovals([bad], VIEWER, "inbox");
    expect(res.sources).toEqual([]);
    expect(res.unavailableSources).toEqual([{ sourceId: "bad", title: "bad", availability: "error", reason: "avail-throw" }]);
  });

  it("a throwing appliesTo() is guarded and reported as error, sibling survives", async () => {
    const bad = fakeSource({
      id: "bad",
      appliesTo: () => {
        throw new Error("applies-throw");
      },
    });
    const good = fakeSource({ id: "good", inbox: async () => ready([row("1", "good")]) });
    const res = await collectApprovals([bad, good], VIEWER, "inbox");
    expect(res.sources.map((s) => s.sourceId)).toEqual(["good"]);
    expect(res.unavailableSources).toEqual([{ sourceId: "bad", title: "bad", availability: "error", reason: "applies-throw" }]);
  });

  it("a throwing sectionConfigured() is guarded and reported as error", async () => {
    const bad = fakeSource({
      id: "bad",
      sectionConfigured: () => {
        throw new Error("section-throw");
      },
    });
    const res = await collectApprovals([bad], VIEWER, "inbox");
    expect(res.sources).toEqual([]);
    expect(res.unavailableSources).toEqual([{ sourceId: "bad", title: "bad", availability: "error", reason: "section-throw" }]);
  });

  it("sourceId filter narrows to a single source", async () => {
    const a = fakeSource({ id: "a", inbox: async () => ready([row("1", "a")]) });
    const b = fakeSource({ id: "b", inbox: async () => ready([row("2", "b")]) });
    const res = await collectApprovals([a, b], VIEWER, "inbox", { sourceId: "b" });
    expect(res.sources.map((s) => s.sourceId)).toEqual(["b"]);
  });

  it("strips the adapter-private `raw` and surfaces the public `version` token", async () => {
    const withRaw = fakeSource({
      id: "v",
      inbox: async () => ready([row("1", "v", { version: "snap-abc", raw: { secret: "snap-abc", other: 1 } })]),
    });
    const res = await collectApprovals([withRaw], VIEWER, "inbox");
    const item = res.sources[0].rows[0];
    expect(item.version).toBe("snap-abc");
    expect("raw" in item).toBe(false);
  });

  it("passes opts.status through as the source history filter", async () => {
    let seen: string | undefined = "UNSET";
    const src = fakeSource({
      id: "s",
      mine: async () => ready([]),
    });
    // Wrap fetchMine to capture opts.
    src.fetchMine = async (_v, opts) => {
      seen = opts?.status;
      return ready([]);
    };
    await collectApprovals([src], VIEWER, "mine", { status: "all" });
    expect(seen).toBe("all");
  });
});

describe("getApprovalItem", () => {
  const src = fakeSource({
    id: "s",
    appliesTo: () => true,
    inbox: async () => ready([row("inbox-1", "s", { version: "v1", raw: { x: 1 } }), row("both", "s", { subtitle: "from-inbox" })]),
    mine: async () => ready([row("mine-1", "s"), row("both", "s", { subtitle: "from-mine" })]),
  });

  it("rejects an unknown sourceId", async () => {
    const res = await getApprovalItem([src], VIEWER, "nope", "x");
    expect(res).toEqual({ ok: false, code: "unknown_source", message: expect.stringContaining("nope") });
  });

  it("finds an item and returns its direction, stripping raw + surfacing version", async () => {
    const res = await getApprovalItem([src], VIEWER, "s", "inbox-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.item.id).toBe("inbox-1");
      expect(res.item.direction).toBe("inbox");
      expect(res.item.version).toBe("v1");
      expect("raw" in res.item).toBe(false);
      expect(res.actions.map((a) => a.id)).toEqual(["approve", "reject"]);
    }
  });

  it("prefers the Inbox occurrence when an id exists in both directions", async () => {
    const res = await getApprovalItem([src], VIEWER, "s", "both");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.item.direction).toBe("inbox");
      expect(res.item.subtitle).toBe("from-inbox");
    }
  });

  it("returns not_found for a missing id in an available source", async () => {
    const res = await getApprovalItem([src], VIEWER, "s", "ghost");
    expect(res).toEqual({ ok: false, code: "not_found", message: expect.stringContaining("ghost") });
  });

  it("returns forbidden when the viewer cannot participate in any direction", async () => {
    const adminOnly = fakeSource({ id: "mod", appliesTo: (v, d) => v.isAdmin && d === "inbox" });
    const res = await getApprovalItem([adminOnly], NON_ADMIN, "mod", "x");
    expect(res).toEqual({ ok: false, code: "forbidden", message: expect.stringContaining("mod") });
  });

  it("surfaces the connectivity state when the source is unavailable in every applicable direction", async () => {
    const nc = fakeSource({ id: "nc", availability: () => "not_connected" });
    const res = await getApprovalItem([nc], VIEWER, "nc", "x");
    expect(res).toEqual({ ok: false, code: "not_connected", message: expect.stringContaining("not_connected") });
  });

  it("surfaces an error (not a spurious forbidden) when appliesTo throws in every direction", async () => {
    const bad = fakeSource({
      id: "bad",
      appliesTo: () => {
        throw new Error("applies-throw");
      },
    });
    const res = await getApprovalItem([bad], VIEWER, "bad", "x");
    expect(res).toEqual({ ok: false, code: "error", message: "applies-throw" });
  });
});

describe("decideApproval", () => {
  it("rejects an unknown / mismatched sourceId (unqualified id never routed to the wrong source)", async () => {
    const res = await decideApproval([fakeSource({ id: "s" })], VIEWER, {
      sourceId: "wrong",
      id: "1",
      decision: "approve",
    });
    expect(res).toEqual({ ok: false, kind: "refused", code: "unknown_source", message: expect.stringContaining("wrong") });
  });

  it("routes to the source's own decide helper with the mapped DecideInput and returns its result verbatim", async () => {
    let captured: DecideInput | undefined;
    const src = fakeSource({
      id: "s",
      decide: async (input) => {
        captured = input;
        return { ok: true };
      },
    });
    const res = await decideApproval([src], VIEWER, {
      sourceId: "s",
      id: "row-9",
      decision: "reject",
      reason: "nope",
      expectedVersion: "snap-1",
    });
    expect(res).toEqual({ ok: true });
    expect(captured).toEqual({ rowId: "row-9", action: "reject", reason: "nope", expectedVersion: "snap-1" });
  });

  it("passes a structured business refusal (e.g. a 409 SoD) through unchanged — never throws", async () => {
    const src = fakeSource({
      id: "s",
      decide: async () => ({ ok: false, kind: "refused", code: "sod_conflict", message: "separation of duties", httpStatus: 409 }),
    });
    const res = await decideApproval([src], VIEWER, { sourceId: "s", id: "1", decision: "approve" });
    expect(res).toEqual({ ok: false, kind: "refused", code: "sod_conflict", message: "separation of duties", httpStatus: 409 });
  });

  it("preserves a CAS source's capture-then-decide guard: absent expectedVersion → structured refusal, present → ok", async () => {
    // Mirrors the agent-creation source: refuse when the token was not captured.
    const cas = fakeSource({
      id: "agent",
      decide: async (input) =>
        input.expectedVersion
          ? { ok: true }
          : { ok: false, kind: "refused", code: "version_required", message: "A snapshot version token is required to decide." },
    });
    const absent = await decideApproval([cas], VIEWER, { sourceId: "agent", id: "1", decision: "approve" });
    expect(absent).toMatchObject({ ok: false, code: "version_required" });
    const present = await decideApproval([cas], VIEWER, { sourceId: "agent", id: "1", decision: "approve", expectedVersion: "snap-xyz" });
    expect(present).toEqual({ ok: true });
  });
});
