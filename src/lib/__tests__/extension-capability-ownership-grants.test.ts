import { describe, it, expect } from "vitest";
import {
  computeManifestBindingHash,
  recordRequestedOwnershipGrant,
  approveOwnershipGrant,
  revokeOwnershipGrant,
  resolveOwnershipOwner,
  readOwnershipGrant,
  restoreOwnershipGrant,
  type OwnershipGrantDeps,
} from "@/lib/extension-capability-ownership-grants";

const PKG = "@cinatra-ai/wordpress-mcp-connector";
const OTHER = "@cinatra-ai/squatter-connector";
const KEY = "wordpress_widget_auth";

// ---------------------------------------------------------------------------
// Fake in-memory ownership-grant store driven by the module's raw SQL. Keyed by
// (package_name, org_id, token_config_key) to mirror the UNIQUE constraint, and
// it ENFORCES the anti-squat partial unique indexes (at most one APPROVED owner
// per (token key, org scope)) so a squatting approval throws exactly as the DB
// would. Statement dispatch is by SQL verb + distinguishing feature.
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  package_name: string;
  org_id: string | null;
  token_config_key: string;
  manifest_binding_hash: string;
  status: string;
  approved_by: string | null;
};

function keyOf(pkg: string, orgId: string | null, tokenKey: string): string {
  return `${pkg}::${orgId ?? "<global>"}::${tokenKey}`;
}

/**
 * Faithfully resolve the org_id a statement binds — `null` for `org_id IS NULL`,
 * else the value at the EXACT `$N` position the SQL names. This makes the harness
 * catch param-index bugs (a wrong `$N` reads the wrong value → wrong/zero rows),
 * which a hardcoded position would silently mask.
 */
function orgParam(text: string, v: readonly unknown[]): string | null {
  if (/org_id IS NULL/.test(text)) return null;
  const m = text.match(/org_id = \$(\d+)/);
  if (!m) throw new Error(`orgParam: no org_id clause in: ${text.slice(0, 80)}`);
  const idx = Number(m[1]) - 1;
  const val = v[idx];
  return val === null || val === undefined ? null : String(val);
}

function fakeDb() {
  const rows = new Map<string, Row>();
  let idSeq = 0;

  const query = async <T,>(text: string, values?: readonly unknown[]): Promise<T[]> => {
    const v = values ?? [];
    const t = text.trimStart();
    const isGlobal = /org_id IS NULL/.test(text);

    // resolveOwnershipOwner: SELECT package_name ... token_config_key = $1 AND
    // (org_id = $2 | org_id IS NULL) AND status = 'approved'
    if (t.startsWith("SELECT package_name")) {
      const tokenKey = String(v[0]);
      const orgId = orgParam(text, v);
      const matches = [...rows.values()].filter(
        (r) =>
          r.token_config_key === tokenKey &&
          (r.org_id ?? null) === orgId &&
          r.status === "approved",
      );
      return matches.map((r) => ({ package_name: r.package_name })) as T[];
    }

    // readGrantRow: SELECT <cols> ... package_name = $1 AND token_config_key = $2
    if (t.startsWith("SELECT")) {
      const pkg = String(v[0]);
      const tokenKey = String(v[1]);
      const orgId = orgParam(text, v);
      const row = rows.get(keyOf(pkg, orgId, tokenKey));
      return (row ? [row] : []) as T[];
    }

    if (t.startsWith("INSERT")) {
      // recordRequested: ($1 pkg, $2 org, $3 tokenKey, $4 hash, 'pending')
      // restore:         ($1 pkg, $2 org, $3 tokenKey, $4 hash, $5 status, $6 approvedBy)
      const isRestore = /status, approved_by/.test(text);
      const pkg = String(v[0]);
      const orgId = v[1] === null || v[1] === undefined ? null : String(v[1]);
      const tokenKey = String(v[2]);
      const hash = String(v[3]);
      const status = isRestore ? String(v[4]) : "pending";
      const approvedBy = isRestore ? (v[5] === null || v[5] === undefined ? null : String(v[5])) : null;
      if (status === "approved") assertNoOtherApproved(rows, pkg, orgId, tokenKey);
      const row: Row = {
        id: `own-${++idSeq}`,
        package_name: pkg,
        org_id: orgId,
        token_config_key: tokenKey,
        manifest_binding_hash: hash,
        status,
        approved_by: approvedBy,
      };
      rows.set(keyOf(pkg, orgId, tokenKey), row);
      return [row] as T[];
    }

    if (t.startsWith("UPDATE")) {
      if (/status = 'approved'/.test(text)) {
        // approve: SET status='approved', approved_by=$1 WHERE pkg=$2 tokenKey=$3 [org=$4]
        const approvedBy = String(v[0]);
        const pkg = String(v[1]);
        const tokenKey = String(v[2]);
        const orgId = orgParam(text, v);
        const row = rows.get(keyOf(pkg, orgId, tokenKey));
        if (!row) return [] as T[];
        assertNoOtherApproved(rows, pkg, orgId, tokenKey);
        row.status = "approved";
        row.approved_by = approvedBy;
        return [row] as T[];
      }
      if (/status = 'revoked'/.test(text)) {
        // revoke: WHERE pkg=$1 tokenKey=$2 [org=$3]
        const pkg = String(v[0]);
        const tokenKey = String(v[1]);
        const orgId = orgParam(text, v);
        const row = rows.get(keyOf(pkg, orgId, tokenKey));
        if (!row) return [] as T[];
        row.status = "revoked";
        row.approved_by = null;
        return [row] as T[];
      }
      if (/manifest_binding_hash = \$2/.test(text)) {
        // restore UPDATE: SET status=$1, hash=$2, approved_by=$3 WHERE pkg=$4 tokenKey=$5 [org=$6]
        const status = String(v[0]);
        const hash = String(v[1]);
        const approvedBy = v[2] === null || v[2] === undefined ? null : String(v[2]);
        const pkg = String(v[3]);
        const tokenKey = String(v[4]);
        const orgId = orgParam(text, v);
        const row = rows.get(keyOf(pkg, orgId, tokenKey));
        if (!row) return [] as T[];
        if (status === "approved") assertNoOtherApproved(rows, pkg, orgId, tokenKey);
        row.status = status;
        row.manifest_binding_hash = hash;
        row.approved_by = approvedBy;
        return [row] as T[];
      }
      // recordRequested reset: SET hash=$1, status='pending', approved_by=NULL WHERE pkg=$2 tokenKey=$3 [org=$4]
      const hash = String(v[0]);
      const pkg = String(v[1]);
      const tokenKey = String(v[2]);
      const orgId = orgParam(text, v);
      const row = rows.get(keyOf(pkg, orgId, tokenKey));
      if (!row) return [] as T[];
      row.manifest_binding_hash = hash;
      row.status = "pending";
      row.approved_by = null;
      return [row] as T[];
    }

    throw new Error(`fakeDb: unhandled statement: ${text.slice(0, 60)}`);
  };

  return { query, rows };
}

/** Mirror the partial unique index: at most one APPROVED row per (token key,
 * org scope) — a second approved owner is a unique violation. */
function assertNoOtherApproved(rows: Map<string, Row>, pkg: string, orgId: string | null, tokenKey: string): void {
  const other = [...rows.values()].find(
    (r) =>
      r.token_config_key === tokenKey &&
      (r.org_id ?? null) === orgId &&
      r.status === "approved" &&
      r.package_name !== pkg,
  );
  if (other) {
    throw new Error(
      `duplicate key value violates unique constraint "extension_capability_ownership_grant_approved_token_uniq"`,
    );
  }
}

function depsFor(db: ReturnType<typeof fakeDb>): OwnershipGrantDeps {
  return { query: db.query, schema: "cinatra" };
}

describe("extension-capability-ownership-grants", () => {
  it("records a pending grant, then resolves NOTHING until approved (fail closed)", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);

    // Pending → no owner resolves.
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBeNull();

    await approveOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "admin-1" }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBe(PKG);
  });

  it("revoke frees the owner (fail closed again)", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "admin-1" }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBe(PKG);

    await revokeOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBeNull();
  });

  it("ANTI-SQUAT: a second package cannot be approved for a token key already owned", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "admin-1" }, deps);

    // A squatter records the SAME token key and an admin tries to approve it.
    await recordRequestedOwnershipGrant({ packageName: OTHER, orgId: null, tokenConfigKey: KEY }, deps);
    await expect(
      approveOwnershipGrant({ packageName: OTHER, orgId: null, tokenConfigKey: KEY, approvedBy: "admin-1" }, deps),
    ).rejects.toThrow(/unique constraint/);

    // The real owner is unchanged — the squat did NOT flip ownership.
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBe(PKG);
  });

  it("re-approve is possible for the SAME package after it revokes (slot freed)", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "a" }, deps);
    await revokeOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    // Another package may now take ownership.
    await recordRequestedOwnershipGrant({ packageName: OTHER, orgId: null, tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: OTHER, orgId: null, tokenConfigKey: KEY, approvedBy: "a" }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBe(OTHER);
  });

  it("a manifest claim change (binding hash) resets an approval to pending", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "a" }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBe(PKG);

    // Simulate a manifest claim change: forcibly corrupt the stored binding hash
    // so the SAME-hash short-circuit does NOT fire and the row resets to pending.
    const row = db.rows.get(`${PKG}::<global>::${KEY}`)!;
    row.manifest_binding_hash = "STALE";
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBeNull();
    expect(db.rows.get(`${PKG}::<global>::${KEY}`)!.status).toBe("pending");
  });

  it("approve throws when the basis does not hash to the stored binding (anti-stale)", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    await expect(
      approveOwnershipGrant(
        { packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "a", tokenConfigKeyBasis: "some_other_key" },
        deps,
      ),
    ).rejects.toThrow(/has changed since the request was recorded/);
  });

  it("approve throws with no recorded request", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    await expect(
      approveOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "a" }, deps),
    ).rejects.toThrow(/record a request first/);
  });

  it("org-scoped owner takes precedence over a global owner", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    // Global owner = PKG.
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "a" }, deps);
    // Org-scoped owner = OTHER for org "org-9".
    await recordRequestedOwnershipGrant({ packageName: OTHER, orgId: "org-9", tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: OTHER, orgId: "org-9", tokenConfigKey: KEY, approvedBy: "a" }, deps);

    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: "org-9" }, deps)).toBe(OTHER);
    // A different org with no org-scoped grant falls back to the global owner.
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: "org-42" }, deps)).toBe(PKG);
    // Global scope resolves the global owner.
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBe(PKG);
  });

  it("restore re-pins an exact prior approved state (durable rollback)", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    const hash = computeManifestBindingHash(KEY);
    await restoreOwnershipGrant(
      { packageName: PKG, orgId: null, tokenConfigKey: KEY, status: "approved", manifestBindingHash: hash, approvedBy: "prior-admin" },
      deps,
    );
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBe(PKG);
    const g = await readOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    expect(g?.status).toBe("approved");
    expect(g?.approvedBy).toBe("prior-admin");
  });

  it("org-scoped approve + revoke + restore bind the correct row (param-index coverage)", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    // Approve an org-scoped grant — a wrong `$N` for the org param would update
    // zero rows and throw "approve returned no row".
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: "org-7", tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: PKG, orgId: "org-7", tokenConfigKey: KEY, approvedBy: "admin" }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: "org-7" }, deps)).toBe(PKG);

    // Restore an org-scoped row to a captured approved state (durable rollback).
    await revokeOwnershipGrant({ packageName: PKG, orgId: "org-7", tokenConfigKey: KEY }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: "org-7" }, deps)).toBeNull();
    await restoreOwnershipGrant(
      {
        packageName: PKG,
        orgId: "org-7",
        tokenConfigKey: KEY,
        status: "approved",
        manifestBindingHash: computeManifestBindingHash(KEY),
        approvedBy: "prior",
      },
      deps,
    );
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: "org-7" }, deps)).toBe(PKG);
    // The org-scoped restore must NOT create a global owner.
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBeNull();
  });

  it("a different token key is independent (no cross-key ownership leak)", async () => {
    const db = fakeDb();
    const deps = depsFor(db);
    await recordRequestedOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY }, deps);
    await approveOwnershipGrant({ packageName: PKG, orgId: null, tokenConfigKey: KEY, approvedBy: "a" }, deps);
    // Drupal key owned by a different package — no collision with the WP key.
    await recordRequestedOwnershipGrant({ packageName: OTHER, orgId: null, tokenConfigKey: "drupal_widget_auth" }, deps);
    await approveOwnershipGrant({ packageName: OTHER, orgId: null, tokenConfigKey: "drupal_widget_auth", approvedBy: "a" }, deps);
    expect(await resolveOwnershipOwner({ tokenConfigKey: KEY, orgId: null }, deps)).toBe(PKG);
    expect(await resolveOwnershipOwner({ tokenConfigKey: "drupal_widget_auth", orgId: null }, deps)).toBe(OTHER);
  });
});
