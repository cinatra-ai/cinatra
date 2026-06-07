import { describe, it, expect } from "vitest";
import {
  computeRequestedPortsHash,
  recordRequestedGrant,
  approveGrant,
  revokeGrant,
  readApprovedPorts,
  type HostPortGrantDeps,
} from "@/lib/extension-host-port-grants";

const PKG = "@cinatra-ai/foo-connector";

// ---------------------------------------------------------------------------
// Fake in-memory grant store driven by the module's raw SQL. Keyed by
// (package_name, org_id) to mirror the UNIQUE constraint. We pattern-match the
// statement verb; the WHERE-clause values are positional and discovered from
// the bound values + the presence of "org_id IS NULL".
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  package_name: string;
  org_id: string | null;
  approved_ports: unknown;
  requested_ports_hash: string;
  status: string;
  approved_by: string | null;
};

function keyOf(packageName: string, orgId: string | null): string {
  return `${packageName}::${orgId ?? "<global>"}`;
}

function fakeDb() {
  const rows = new Map<string, Row>();
  let idSeq = 0;

  const query = async <T,>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    const v = values ?? [];
    const isGlobal = /org_id IS NULL/.test(text);

    if (text.trimStart().startsWith("SELECT")) {
      // SELECT ... WHERE package_name = $1 AND (org_id IS NULL | org_id = $2)
      const packageName = String(v[0]);
      const orgId = isGlobal ? null : String(v[1]);
      const row = rows.get(keyOf(packageName, orgId));
      return (row ? [row] : []) as T[];
    }

    if (text.trimStart().startsWith("INSERT")) {
      // INSERT (package_name $1, org_id $2, approved '[]', hash $3, status 'pending')
      const packageName = String(v[0]);
      const orgId = v[1] === null || v[1] === undefined ? null : String(v[1]);
      const hash = String(v[2]);
      const row: Row = {
        id: `grant-${++idSeq}`,
        package_name: packageName,
        org_id: orgId,
        approved_ports: [],
        requested_ports_hash: hash,
        status: "pending",
        approved_by: null,
      };
      rows.set(keyOf(packageName, orgId), row);
      return [row] as T[];
    }

    if (text.trimStart().startsWith("UPDATE")) {
      if (/status = 'approved'/.test(text)) {
        // UPDATE ... SET approved_ports $1, approved_by $2 WHERE package_name $3 AND org
        const approvedPorts = JSON.parse(String(v[0]));
        const approvedBy = v[1] === null ? null : String(v[1]);
        const packageName = String(v[2]);
        const orgId = isGlobal ? null : String(v[3]);
        const row = rows.get(keyOf(packageName, orgId));
        if (!row) return [] as T[];
        row.status = "approved";
        row.approved_ports = approvedPorts;
        row.approved_by = approvedBy;
        return [row] as T[];
      }
      if (/status = 'revoked'/.test(text)) {
        // UPDATE ... SET status revoked WHERE package_name $1 AND org
        const packageName = String(v[0]);
        const orgId = isGlobal ? null : String(v[1]);
        const row = rows.get(keyOf(packageName, orgId));
        if (!row) return [] as T[];
        row.status = "revoked";
        row.approved_ports = [];
        return [row] as T[];
      }
      // re-request reset: SET requested_ports_hash $1, status pending WHERE pkg $2 AND org
      const hash = String(v[0]);
      const packageName = String(v[1]);
      const orgId = isGlobal ? null : String(v[2]);
      const row = rows.get(keyOf(packageName, orgId));
      if (!row) return [] as T[];
      row.requested_ports_hash = hash;
      row.status = "pending";
      row.approved_ports = [];
      row.approved_by = null;
      return [row] as T[];
    }

    throw new Error(`unhandled SQL in fake: ${text.slice(0, 40)}`);
  };

  return { query, rows };
}

function deps(db: ReturnType<typeof fakeDb>): HostPortGrantDeps {
  return { query: db.query, schema: "cinatra" };
}

// ---------------------------------------------------------------------------

describe("computeRequestedPortsHash", () => {
  it("is stable + order- and duplicate-independent", () => {
    const a = computeRequestedPortsHash(["db", "secrets", "settings"]);
    const b = computeRequestedPortsHash(["settings", "db", "secrets"]);
    const c = computeRequestedPortsHash(["db", "db", "secrets", "settings", "settings"]);
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when the requested port set changes", () => {
    const base = computeRequestedPortsHash(["db", "secrets"]);
    expect(computeRequestedPortsHash(["db"])).not.toBe(base);
    expect(computeRequestedPortsHash(["db", "secrets", "jobs"])).not.toBe(base);
  });
});

describe("recordRequestedGrant", () => {
  it("inserts a pending row on first request with the requested-ports hash", async () => {
    const db = fakeDb();
    const grant = await recordRequestedGrant(
      { packageName: PKG, orgId: null, requestedPorts: ["db", "secrets"] },
      deps(db),
    );
    expect(grant.status).toBe("pending");
    expect(grant.approvedPorts).toEqual([]);
    expect(grant.requestedPortsHash).toBe(computeRequestedPortsHash(["db", "secrets"]));
  });

  it("leaves an existing row untouched when the requested-ports hash is unchanged", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await approveGrant(
      { packageName: PKG, orgId: null, approvedPorts: ["db"], approvedBy: "admin", requestedPorts: ["db"] },
      deps(db),
    );
    const again = await recordRequestedGrant(
      { packageName: PKG, orgId: null, requestedPorts: ["db"] },
      deps(db),
    );
    // same hash → approval preserved
    expect(again.status).toBe("approved");
    expect(again.approvedPorts).toEqual(["db"]);
  });

  it("resets an approved row to pending (clearing approval) when requested ports change", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await approveGrant(
      { packageName: PKG, orgId: null, approvedPorts: ["db"], approvedBy: "admin", requestedPorts: ["db"] },
      deps(db),
    );
    const changed = await recordRequestedGrant(
      { packageName: PKG, orgId: null, requestedPorts: ["db", "secrets"] },
      deps(db),
    );
    expect(changed.status).toBe("pending");
    expect(changed.approvedPorts).toEqual([]);
    expect(changed.approvedBy).toBe(null);
    expect(changed.requestedPortsHash).toBe(computeRequestedPortsHash(["db", "secrets"]));
    // and readApprovedPorts now fails closed
    expect(await readApprovedPorts({ packageName: PKG, orgId: null }, deps(db))).toEqual([]);
  });
});

describe("approveGrant", () => {
  it("approves a subset of the requested ports", async () => {
    const db = fakeDb();
    await recordRequestedGrant(
      { packageName: PKG, orgId: null, requestedPorts: ["db", "secrets", "jobs"] },
      deps(db),
    );
    const grant = await approveGrant(
      {
        packageName: PKG,
        orgId: null,
        approvedPorts: ["db", "secrets"],
        approvedBy: "admin-1",
        requestedPorts: ["db", "secrets", "jobs"],
      },
      deps(db),
    );
    expect(grant.status).toBe("approved");
    expect(grant.approvedPorts).toEqual(["db", "secrets"]);
    expect(grant.approvedBy).toBe("admin-1");
  });

  it("rejects approving a superset (a port that was never requested)", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await expect(
      approveGrant(
        {
          packageName: PKG,
          orgId: null,
          approvedPorts: ["db", "secrets"],
          approvedBy: "admin",
          requestedPorts: ["db"],
        },
        deps(db),
      ),
    ).rejects.toThrow(/not requested/);
  });

  it("rejects approving against a stale requested-ports set", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await expect(
      approveGrant(
        {
          packageName: PKG,
          orgId: null,
          approvedPorts: ["db"],
          approvedBy: "admin",
          requestedPorts: ["db", "secrets"], // does not match stored hash
        },
        deps(db),
      ),
    ).rejects.toThrow(/changed since the request/);
  });

  it("throws when no requested grant exists", async () => {
    const db = fakeDb();
    await expect(
      approveGrant(
        { packageName: PKG, orgId: null, approvedPorts: ["db"], approvedBy: "admin", requestedPorts: ["db"] },
        deps(db),
      ),
    ).rejects.toThrow(/No requested host-port grant/);
  });
});

describe("revokeGrant", () => {
  it("sets status revoked and clears approved ports", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await approveGrant(
      { packageName: PKG, orgId: null, approvedPorts: ["db"], approvedBy: "admin", requestedPorts: ["db"] },
      deps(db),
    );
    const revoked = await revokeGrant({ packageName: PKG, orgId: null }, deps(db));
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.approvedPorts).toEqual([]);
    expect(await readApprovedPorts({ packageName: PKG, orgId: null }, deps(db))).toEqual([]);
  });
});

describe("readApprovedPorts (fail closed)", () => {
  it("returns [] for a pending row", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    expect(await readApprovedPorts({ packageName: PKG, orgId: null }, deps(db))).toEqual([]);
  });

  it("returns approved ports only when status is approved", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db", "secrets"] }, deps(db));
    await approveGrant(
      {
        packageName: PKG,
        orgId: null,
        approvedPorts: ["db", "secrets"],
        approvedBy: "admin",
        requestedPorts: ["db", "secrets"],
      },
      deps(db),
    );
    expect(await readApprovedPorts({ packageName: PKG, orgId: null }, deps(db))).toEqual(["db", "secrets"]);
  });

  it("returns [] for a missing row", async () => {
    const db = fakeDb();
    expect(await readApprovedPorts({ packageName: PKG, orgId: null }, deps(db))).toEqual([]);
  });

  it("returns [] after revoke", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await approveGrant(
      { packageName: PKG, orgId: null, approvedPorts: ["db"], approvedBy: "admin", requestedPorts: ["db"] },
      deps(db),
    );
    await revokeGrant({ packageName: PKG, orgId: null }, deps(db));
    expect(await readApprovedPorts({ packageName: PKG, orgId: null }, deps(db))).toEqual([]);
  });
});

describe("org-row precedence over global", () => {
  it("prefers an approved org-specific row over a global row", async () => {
    const db = fakeDb();
    // global grant approved with [db]
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await approveGrant(
      { packageName: PKG, orgId: null, approvedPorts: ["db"], approvedBy: "admin", requestedPorts: ["db"] },
      deps(db),
    );
    // org grant approved with [db, secrets]
    await recordRequestedGrant({ packageName: PKG, orgId: "org-1", requestedPorts: ["db", "secrets"] }, deps(db));
    await approveGrant(
      {
        packageName: PKG,
        orgId: "org-1",
        approvedPorts: ["db", "secrets"],
        approvedBy: "admin",
        requestedPorts: ["db", "secrets"],
      },
      deps(db),
    );
    expect(await readApprovedPorts({ packageName: PKG, orgId: "org-1" }, deps(db))).toEqual(["db", "secrets"]);
    // global lookup unaffected
    expect(await readApprovedPorts({ packageName: PKG, orgId: null }, deps(db))).toEqual(["db"]);
  });

  it("does NOT fall back to the global row when an org row exists but is not approved", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await approveGrant(
      { packageName: PKG, orgId: null, approvedPorts: ["db"], approvedBy: "admin", requestedPorts: ["db"] },
      deps(db),
    );
    // org row exists but only pending → fail closed, do NOT inherit the global approval
    await recordRequestedGrant({ packageName: PKG, orgId: "org-1", requestedPorts: ["db"] }, deps(db));
    expect(await readApprovedPorts({ packageName: PKG, orgId: "org-1" }, deps(db))).toEqual([]);
  });

  it("falls back to a global approved row when NO org row exists", async () => {
    const db = fakeDb();
    await recordRequestedGrant({ packageName: PKG, orgId: null, requestedPorts: ["db"] }, deps(db));
    await approveGrant(
      { packageName: PKG, orgId: null, approvedPorts: ["db"], approvedBy: "admin", requestedPorts: ["db"] },
      deps(db),
    );
    expect(await readApprovedPorts({ packageName: PKG, orgId: "org-2" }, deps(db))).toEqual(["db"]);
  });
});
