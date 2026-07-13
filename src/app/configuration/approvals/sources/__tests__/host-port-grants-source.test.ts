// cinatra#1391 slice 1 — the host-port-grant ApprovalSource: opaque scope-id
// round-trip, the admin + scope-confinement + approve-only decide gates (each
// short-circuiting BEFORE the backend), the empty "Your requests" envelope, and
// the Inbox row mapping/rendering. The union-aware backend is mocked (its own
// ladder is proven in extension-host-port-grant-review.test.ts).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const listHostPortGrantReviewRows = vi.fn();
const approveHostPortGrantUnion = vi.fn();
const countPendingHostPortGrants = vi.fn(async () => 0);
vi.mock("@/lib/extension-host-port-grant-review", () => ({
  listHostPortGrantReviewRows: (...a: unknown[]) => listHostPortGrantReviewRows(...(a as [])),
  approveHostPortGrantUnion: (...a: unknown[]) => approveHostPortGrantUnion(...(a as [])),
  countPendingHostPortGrants: (...a: unknown[]) => countPendingHostPortGrants(...(a as [])),
}));

// Stub the client component + Badge to inert nodes — the row-render assertions
// exercise the plain title/union text the source itself emits.
vi.mock("../../host-port-grant-decision-actions", () => ({
  HostPortGrantDecisionActions: () => null,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: () => null,
}));

import {
  hostPortGrantsSource,
  encodeHostPortGrantRowId,
  decodeHostPortGrantRowId,
} from "../host-port-grants";
import type { HostPortGrantReviewRow } from "@/lib/extension-host-port-grant-review";
import type { ApprovalRow, ApprovalViewer } from "../types";

const admin: ApprovalViewer = { userId: "u-admin", orgId: "org-1", isAdmin: true };
const member: ApprovalViewer = { userId: "u-member", orgId: "org-1", isAdmin: false };

const PKG = "@cinatra-ai/foo-connector";

function reviewRow(over: Partial<HostPortGrantReviewRow> = {}): HostPortGrantReviewRow {
  return {
    packageName: PKG,
    orgId: null,
    status: "pending",
    approvedPorts: [],
    requestedPortsHash: "hash-123",
    approvedBy: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    currentUnion: ["p1", "p2"],
    perVersion: [{ version: "0.2.1", isDefault: true, ports: ["p1"] }],
    stale: false,
    ...over,
  } as HostPortGrantReviewRow;
}

beforeEach(() => {
  vi.clearAllMocks();
  countPendingHostPortGrants.mockResolvedValue(0);
});

describe("row-id scope encoding", () => {
  it("round-trips (packageName, orgId) opaquely, including the platform (null) scope", () => {
    for (const orgId of [null, "org-1"]) {
      const id = encodeHostPortGrantRowId(PKG, orgId);
      expect(decodeHostPortGrantRowId(id)).toEqual({ packageName: PKG, orgId });
    }
  });

  it("decodes malformed input to null (never a throw)", () => {
    expect(decodeHostPortGrantRowId("not-base64url!!!")).toBeNull();
    expect(decodeHostPortGrantRowId(Buffer.from('["only-one"]').toString("base64url"))).toBeNull();
    expect(decodeHostPortGrantRowId(Buffer.from('{"not":"array"}').toString("base64url"))).toBeNull();
  });
});

describe("fetchInbox / fetchMine", () => {
  it("admin Inbox maps the review rows (scope = [orgId, null]); the union hash is the version token", async () => {
    listHostPortGrantReviewRows.mockResolvedValueOnce([reviewRow()]);
    const env = await hostPortGrantsSource.fetchInbox(admin);
    expect(listHostPortGrantReviewRows).toHaveBeenCalledWith({ orgIds: ["org-1", null] });
    expect(env.rows).toHaveLength(1);
    const row = env.rows[0]!;
    expect(row.title).toBe(PKG);
    expect(row.version).toBe("hash-123"); // requestedPortsHash → edit-after-view token
    expect(decodeHostPortGrantRowId(row.id)).toEqual({ packageName: PKG, orgId: null });
    // Approve-only action set.
    expect(env.actions.map((a) => a.id)).toEqual(["approve"]);
  });

  it("a NON-admin Inbox performs NO fetch and returns an empty ready envelope", async () => {
    const env = await hostPortGrantsSource.fetchInbox(member);
    expect(listHostPortGrantReviewRows).not.toHaveBeenCalled();
    expect(env.rows).toEqual([]);
    expect(env.availability).toBe("ready");
  });

  it('"Your requests" is always empty — grants are machine-requested', async () => {
    const env = await hostPortGrantsSource.fetchMine(admin);
    expect(env.rows).toEqual([]);
  });
});

describe("decide — gates short-circuit BEFORE the backend", () => {
  it("refuses a non-admin (forbidden) without calling the backend", async () => {
    const res = await hostPortGrantsSource.actions.decide(
      { rowId: encodeHostPortGrantRowId(PKG, null), action: "approve", expectedVersion: "h" },
      member,
    );
    expect(res).toMatchObject({ ok: false, kind: "forbidden" });
    expect(approveHostPortGrantUnion).not.toHaveBeenCalled();
  });

  it("refuses a non-approve action (approve-only)", async () => {
    const res = await hostPortGrantsSource.actions.decide(
      { rowId: encodeHostPortGrantRowId(PKG, null), action: "reject", expectedVersion: "h" },
      admin,
    );
    expect(res).toMatchObject({ ok: false, code: "unknown_action" });
    expect(approveHostPortGrantUnion).not.toHaveBeenCalled();
  });

  it("refuses an undecodable row id (not_found)", async () => {
    const res = await hostPortGrantsSource.actions.decide(
      { rowId: "garbage", action: "approve", expectedVersion: "h" },
      admin,
    );
    expect(res).toMatchObject({ ok: false, code: "not_found" });
    expect(approveHostPortGrantUnion).not.toHaveBeenCalled();
  });

  it("refuses a row id naming ANOTHER org's scope (forbidden), even for an admin", async () => {
    const res = await hostPortGrantsSource.actions.decide(
      { rowId: encodeHostPortGrantRowId(PKG, "org-OTHER"), action: "approve", expectedVersion: "h" },
      admin,
    );
    expect(res).toMatchObject({ ok: false, kind: "forbidden", code: "not_authorized" });
    expect(approveHostPortGrantUnion).not.toHaveBeenCalled();
  });

  it("delegates a well-formed admin approve to the union backend and maps its refusal codes", async () => {
    approveHostPortGrantUnion.mockResolvedValueOnce({ ok: false, code: "stale_snapshot", message: "changed" });
    const res = await hostPortGrantsSource.actions.decide(
      { rowId: encodeHostPortGrantRowId(PKG, null), action: "approve", expectedVersion: "tok" },
      admin,
    );
    expect(approveHostPortGrantUnion).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: null,
      approvedBy: "u-admin",
      expectedRequestedPortsHash: "tok",
    });
    expect(res).toMatchObject({ ok: false, code: "stale_snapshot", kind: "refused" });
  });

  it("returns ok:true on a successful backend approval", async () => {
    approveHostPortGrantUnion.mockResolvedValueOnce({ ok: true });
    const res = await hostPortGrantsSource.actions.decide(
      { rowId: encodeHostPortGrantRowId(PKG, "org-1"), action: "approve", expectedVersion: "tok" },
      admin,
    );
    expect(res).toEqual({ ok: true });
  });
});

describe("rowRenderer", () => {
  it("renders the package title, the requested union, and the approve control on Inbox", async () => {
    listHostPortGrantReviewRows.mockResolvedValueOnce([reviewRow({ currentUnion: ["p1", "p2"] })]);
    const env = await hostPortGrantsSource.fetchInbox(admin);
    const html = renderToStaticMarkup(
      hostPortGrantsSource.rowRenderer(env.rows[0] as ApprovalRow, { direction: "inbox" }) as never,
    );
    expect(html).toContain(PKG);
    expect(html).toContain("p1, p2");
  });
});
