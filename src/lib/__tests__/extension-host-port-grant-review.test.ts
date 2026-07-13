// cinatra#1391 slice 1 — the UNION-AWARE host-port grant RE-APPROVAL backend.
// Fully dependency-injected: no fs/db. Proves the review-row enrichment, the
// pending count, and the anti-stale approval ladder (version token required,
// not-found, not-pending, edit-after-view stale_snapshot, live-moved
// stale_request with re-record, and the happy full-union approval under lock).
import { describe, it, expect, vi } from "vitest";

import {
  approveHostPortGrantUnion,
  listHostPortGrantReviewRows,
  type HostPortGrantReviewDeps,
} from "@/lib/extension-host-port-grant-review";

const PKG = "@cinatra-ai/foo-connector";
const hash = (ports: readonly string[]): string =>
  `h:${Array.from(new Set(ports.map(String))).sort().join(",")}`;

type GrantRow = {
  packageName: string;
  orgId: string | null;
  status: "pending" | "approved" | "revoked";
  approvedPorts: string[];
  requestedPortsHash: string;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

function grant(over: Partial<GrantRow> = {}): GrantRow {
  return {
    packageName: PKG,
    orgId: null,
    status: "pending",
    approvedPorts: [],
    requestedPortsHash: hash(["p1", "p2"]),
    approvedBy: null,
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...over,
  };
}

// A deps object whose fns are vi.fn spies so assertions can inspect the calls.
function deps(over: Partial<HostPortGrantReviewDeps> = {}): HostPortGrantReviewDeps {
  return {
    computeRequestedPortsHash: hash,
    withInstallLock: async (_pkg, fn) => fn(),
    recordRequestedGrant: vi.fn(async () => undefined),
    approveGrant: vi.fn(async () => undefined),
    ...over,
  };
}

describe("listHostPortGrantReviewRows / countPendingHostPortGrants", () => {
  it("enriches each pending grant with the live union + per-version evidence + stale flag", async () => {
    const pending = grant({ requestedPortsHash: hash(["p1", "p2"]) });
    const d = deps({
      listGrantsForScopes: vi.fn(async () => [pending]) as never,
      readUnionPorts: vi.fn(async () => ["p1", "p2"]),
      readPerVersionPorts: vi.fn(async () => [
        { version: "0.2.1", isDefault: true, ports: ["p1"] },
        { version: "0.3.0", isDefault: false, ports: ["p2"] },
      ]),
    });
    const rows = await listHostPortGrantReviewRows({ orgIds: [null] }, d);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      packageName: PKG,
      currentUnion: ["p1", "p2"],
      stale: false, // hash(union) === stored requested hash
    });
    expect(rows[0]!.perVersion).toHaveLength(2);
  });

  it("marks a row STALE when the live union no longer hashes to the stored request", async () => {
    const pending = grant({ requestedPortsHash: hash(["p1"]) });
    const d = deps({
      listGrantsForScopes: vi.fn(async () => [pending]) as never,
      readUnionPorts: vi.fn(async () => ["p1", "p2"]), // grew since recorded
      readPerVersionPorts: vi.fn(async () => []),
    });
    const [row] = await listHostPortGrantReviewRows({ orgIds: [null] }, d);
    expect(row!.stale).toBe(true);
  });

});

describe("approveHostPortGrantUnion — anti-stale approval ladder", () => {
  it("REFUSES version_required without the edit-after-view token (never reads a fresh hash)", async () => {
    const readGrantForScope = vi.fn(async () => grant());
    const res = await approveHostPortGrantUnion(
      { packageName: PKG, orgId: null, approvedBy: "admin", expectedRequestedPortsHash: undefined },
      deps({ readGrantForScope: readGrantForScope as never }),
    );
    expect(res).toMatchObject({ ok: false, code: "version_required" });
    expect(readGrantForScope).not.toHaveBeenCalled(); // short-circuits before the lock/read
  });

  it("REFUSES not_found when no grant row exists", async () => {
    const res = await approveHostPortGrantUnion(
      { packageName: PKG, orgId: null, approvedBy: "admin", expectedRequestedPortsHash: hash(["p1"]) },
      deps({ readGrantForScope: (async () => null) as never }),
    );
    expect(res).toMatchObject({ ok: false, code: "not_found" });
  });

  it("REFUSES not_pending when the grant is not pending", async () => {
    const res = await approveHostPortGrantUnion(
      { packageName: PKG, orgId: null, approvedBy: "admin", expectedRequestedPortsHash: hash(["p1"]) },
      deps({ readGrantForScope: (async () => grant({ status: "approved", requestedPortsHash: hash(["p1"]) })) as never }),
    );
    expect(res).toMatchObject({ ok: false, code: "not_pending" });
  });

  it("REFUSES stale_snapshot when the stored request changed after the admin viewed it", async () => {
    const approveGrant = vi.fn(async () => undefined);
    const res = await approveHostPortGrantUnion(
      { packageName: PKG, orgId: null, approvedBy: "admin", expectedRequestedPortsHash: hash(["OLD"]) },
      deps({
        readGrantForScope: (async () => grant({ requestedPortsHash: hash(["p1", "p2"]) })) as never,
        approveGrant,
      }),
    );
    expect(res).toMatchObject({ ok: false, code: "stale_snapshot" });
    expect(approveGrant).not.toHaveBeenCalled();
  });

  it("REFUSES stale_request AND re-records the fresh union when the live world moved past the stored request", async () => {
    const stored = hash(["p1", "p2"]);
    const recordRequestedGrant = vi.fn(async () => undefined);
    const approveGrant = vi.fn(async () => undefined);
    const res = await approveHostPortGrantUnion(
      { packageName: PKG, orgId: null, approvedBy: "admin", expectedRequestedPortsHash: stored },
      deps({
        readGrantForScope: (async () => grant({ requestedPortsHash: stored })) as never,
        readUnionPorts: async () => ["p1", "p2", "p3"], // a sibling installed since
        recordRequestedGrant,
        approveGrant,
      }),
    );
    expect(res).toMatchObject({ ok: false, code: "stale_request" });
    expect(recordRequestedGrant).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: null,
      requestedPorts: ["p1", "p2", "p3"],
    });
    expect(approveGrant).not.toHaveBeenCalled();
  });

  it("APPROVES the full recomputed union under the install lock when everything is consistent", async () => {
    const union = ["p1", "p2"];
    const stored = hash(union);
    const approveGrant = vi.fn(async () => undefined);
    const withInstallLock = vi.fn(async (_pkg: string, fn: () => Promise<unknown>) => fn());
    const res = await approveHostPortGrantUnion(
      { packageName: PKG, orgId: null, approvedBy: "admin-42", expectedRequestedPortsHash: stored },
      deps({
        readGrantForScope: (async () => grant({ requestedPortsHash: stored })) as never,
        readUnionPorts: async () => union,
        approveGrant,
        withInstallLock: withInstallLock as never,
      }),
    );
    expect(res).toEqual({ ok: true });
    expect(withInstallLock).toHaveBeenCalledWith(PKG, expect.any(Function));
    expect(approveGrant).toHaveBeenCalledWith({
      packageName: PKG,
      orgId: null,
      approvedPorts: union,
      requestedPorts: union,
      approvedBy: "admin-42",
    });
  });
});
