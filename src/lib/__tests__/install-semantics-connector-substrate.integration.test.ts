/**
 * THE DB-LAYER PROOF of the connector substrate (cinatra#2694 / S3 #2697) —
 * a WORKSPACE-INSTALLED CONNECTOR, written by the real lifecycle primitive at
 * the anchor S1/S2 resolve, then USED FROM TWO DIFFERENT ORGANIZATIONS through
 * the real resolution seams against a real Postgres.
 *
 * S3's acceptance, asserted here:
 *   - a workspace-installed connector is usable from TWO organizations: both
 *     canonical connector-access resolvers resolve the SAME workspace row for
 *     an actor in org A and an actor in org B, and the addressability +
 *     trust-anchor resolution behind the runtime card record resolve it too;
 *   - credentials/connection semantics are unchanged: the resolved resource
 *     identity IS the canonical row id both orgs share, and the access policy /
 *     co-owner / declaration reads hang off THAT id exactly as before;
 *   - where an org row and a workspace row coexist for one package, the ORG row
 *     wins for that org and the workspace row serves the others;
 *   - bundled/system connector behavior is unchanged (regression fixture).
 *
 * WHY AT THIS LAYER. The unit suites pin each seam's rule over injected rows.
 * They cannot answer whether the workspace-anchored connector row is admitted
 * by the platform-invariant CHECK at all, whether the org-first/workspace-
 * fallback SQL actually orders the two candidate rows the way the rule reads,
 * or whether the trust anchor binds the workspace row's own (org-NULL) journal
 * scope rather than the actor's org. Only a real DB does.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5434/postgres \
 *     pnpm test:install-semantics
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const TEST_SCHEMA = "cinatra_test_connector_substrate_2697";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

const ORG_A = "org-2697-a";
const ORG_B = "org-2697-b";
/** The workspace-installed connector — one row, both orgs. */
const WS_PKG = "@cinatra-ai/ws-connector-2697";
/** A package that ends up with BOTH an org-A row and a workspace row. */
const BOTH_PKG = "@cinatra-ai/both-connector-2697";
/** A bundled/system connector — the regression fixture. */
const BUNDLED_PKG = "@cinatra-ai/bundled-connector-2697";
const ALL_PKGS = [WS_PKG, BOTH_PKG, BUNDLED_PKG];

let canonicalStore: typeof import("@cinatra-ai/extensions/canonical-store");
let lifecycle: typeof import("@cinatra-ai/extensions/lifecycle-primitive");
let anchors: typeof import("@cinatra-ai/extensions/install-row-anchor");
let contract: typeof import("@cinatra-ai/extensions/install-access-target");
let resourceIdentity: typeof import("@cinatra-ai/extensions/extension-resource-identity");
let syncResolver: typeof import("@/lib/connector-access-resolver");
let resolution: typeof import("@/lib/extension-install-resolution");
let installAnchor: typeof import("@/lib/extension-install-anchor");
let installOps: typeof import("@/lib/extension-install-ops");
let accessContract: typeof import("@cinatra-ai/extensions/install-access-contract");
let client: Client;

/** A REAL-PIPELINE verdaccio source: the trust anchor refuses anything less. */
function realSource(packageName: string, digest: string) {
  return {
    type: "verdaccio" as const,
    registryUrl: "http://localhost:4873",
    packageName,
    version: "1.0.0",
    integrity: "sha512-real-2697",
    contentHash: "sha256-content-2697",
    activeDigest: digest,
  };
}

async function installConnectorAtAnchor(
  anchor: { ownerLevel: string; ownerId: string | null; organizationId: string | null },
  packageName: string,
  over: { source?: Record<string, unknown>; digest?: string } = {},
): Promise<string> {
  const id = `iext_${randomUUID().slice(0, 12)}`;
  await lifecycle.installExtensionManifest(
    {
      id,
      packageName,
      ownerLevel: anchor.ownerLevel as never,
      ownerId: anchor.ownerId,
      organizationId: anchor.organizationId,
      kind: "connector" as never,
      source: (over.source ?? realSource(packageName, over.digest ?? "sha256-digest-a")) as never,
      requiredInProd: false,
      dependencies: [],
      manifestHash: null,
      status: "active",
    } as never,
    { actor: { source: "dispatcher", userId: "u-2697" }, reason: "cinatra#2697 fixture" },
  );
  return id;
}

/** The workspace anchor the S1 contract resolves for a "Workspace: All" target. */
function workspaceAnchor() {
  return anchors.resolveInstallRowAnchor(ORG_A, contract.WORKSPACE_ANCHOR_ROW_OWNERSHIP);
}

/** A plain member actor in `orgId` (no admin standing — the weakest case). */
function memberActor(orgId: string) {
  return {
    organizationId: orgId,
    principalId: `user-${orgId}`,
    teamIds: [] as string[],
    platformRole: "member" as const,
    orgRole: "member" as const,
  };
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  // The install-time access contract validates its policy through
  // @cinatra-ai/agents/auth-policy, whose import graph asserts an auth secret is
  // configured at module load. Nothing in this fixture authenticates anybody —
  // a placeholder satisfies the load-time assertion so the ACCESS WRITE can be
  // exercised against the real DB.
  process.env.BETTER_AUTH_SECRET ||= "test-only-placeholder-2697";

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S" && head !== "DO $$")
      continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  canonicalStore = await import("@cinatra-ai/extensions/canonical-store");
  lifecycle = await import("@cinatra-ai/extensions/lifecycle-primitive");
  anchors = await import("@cinatra-ai/extensions/install-row-anchor");
  contract = await import("@cinatra-ai/extensions/install-access-target");
  resourceIdentity = await import("@cinatra-ai/extensions/extension-resource-identity");
  accessContract = await import("@cinatra-ai/extensions/install-access-contract");
  syncResolver = await import("@/lib/connector-access-resolver");
  resolution = await import("@/lib/extension-install-resolution");
  installAnchor = await import("@/lib/extension-install-anchor");
  installOps = await import("@/lib/extension-install-ops");

  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 180_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

beforeEach(async () => {
  if (!HAS_DB) return;
  // Per-test cleanup THROUGH THE PRIMITIVE — never a raw write against
  // installed_extension (the canonical-gate drift guard confines those to the
  // store + DDL, and this fixture is no exception).
  for (const pkg of ALL_PKGS) {
    for (const row of await canonicalStore.readInstalledExtensionsByPackageName(pkg)) {
      await lifecycle.deleteScopedCanonicalRow(row.id);
    }
  }
  await client.query(`DELETE FROM "${q(TEST_SCHEMA)}"."extension_install_ops"`).catch(() => {});
});

// ---------------------------------------------------------------------------
// AC-1 — a workspace-installed connector is usable from TWO organizations
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("cinatra#2697 AC-1 — one workspace connector, two organizations", () => {
  it("the row lands at the workspace anchor (the #1125 refusal no longer applies to it)", async () => {
    const id = await installConnectorAtAnchor(workspaceAnchor(), WS_PKG);
    const res = await client.query(
      `SELECT owner_level, owner_id, organization_id, kind FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE id = $1`,
      [id],
    );
    expect(res.rows[0]).toEqual({
      owner_level: "workspace",
      owner_id: "__platform__",
      organization_id: null,
      kind: "connector",
    });
  });

  it("BOTH canonical resolvers resolve the SAME workspace row for org A and org B", async () => {
    const id = await installConnectorAtAnchor(workspaceAnchor(), WS_PKG);

    for (const org of [ORG_A, ORG_B]) {
      // Seam 1 — the async canonical resolver (@cinatra-ai/extensions).
      const resource = await resourceIdentity.resolveConnectorResource(org, WS_PKG);
      expect(resource?.resourceId, `async resolver for ${org}`).toBe(id);
      // The resolved owner context names NO organization, so the cross-org
      // guard has nothing to fence — that is what gives the row app-wide reach.
      expect(resource?.owner).toEqual({
        ownerLevel: "workspace",
        ownerId: "__platform__",
        organizationId: null,
      });

      // Seam 2 — the SYNC canonical resolver (the connector-policy render path).
      const sync = syncResolver.resolveConnectorCanonicalAccessSync(org, WS_PKG);
      expect(sync.status, `sync resolver for ${org}`).toBe("found");
      if (sync.status !== "found") throw new Error("unreachable");
      expect(sync.access.resourceId).toBe(id);
      expect(sync.access.owner).toEqual({
        ownerLevel: "workspace",
        ownerId: "__platform__",
        organizationId: null,
      });
    }
  });

  it("the ONE resolved resource id carries the access policy for both orgs (credentials/connection semantics unchanged)", async () => {
    const id = await installConnectorAtAnchor(workspaceAnchor(), WS_PKG);
    // The install-time access contract writes the audience the "Workspace: All"
    // target resolved — against the resolved RESOURCE ID, exactly as for an
    // org-anchored connector. Nothing about how access/credentials attach to a
    // connector changed in S3; only WHICH row an org resolves.
    const { policy } = contract.resolveInstallAccessTargetContract(
      { level: "workspace", id: ORG_A },
      ORG_A,
    );
    await accessContract.setExtensionInstallAccess({
      kind: "connector",
      resourceId: id,
      policy,
      installedByUserId: "u-2697",
    });

    for (const org of [ORG_A, ORG_B]) {
      const sync = syncResolver.resolveConnectorCanonicalAccessSync(org, WS_PKG);
      if (sync.status !== "found") throw new Error(`expected found for ${org}`);
      expect(sync.access.resourceId).toBe(id);
      expect(sync.access.policy?.runListVisibility, org).toEqual(["workspace"]);
      expect(sync.access.installedByUserId, org).toBe("u-2697");
      expect(sync.access.coOwnerUserIds, org).toEqual([]);
    }
  });

  it("the runtime card record's gates resolve the workspace row for an org actor", async () => {
    const digest = "sha256-digest-ws";
    const id = await installConnectorAtAnchor(workspaceAnchor(), WS_PKG, { digest });
    // The workspace row's OWN journal scope is org-NULL — the install that
    // wrote it was platform-wide.
    await installOps.beginInstallOp({
      installOpId: `op-${randomUUID().slice(0, 8)}`,
      packageName: WS_PKG,
      orgId: null,
      phase: "materialized",
      digest,
      version: "1.0.0",
    });
    const ops = await installOps.readInstallOp(WS_PKG, null);
    await installOps.finalizeInstallOp(ops!.installOpId);

    for (const org of [ORG_A, ORG_B]) {
      // Gate (a) — an ACTIVE install addressable in the actor's scope. The
      // addressability layer already admitted org-NULL rows before S3.
      const active = await resolution.resolveActiveInstallIdForActor(WS_PKG, memberActor(org) as never);
      expect(active, `gate (a) for ${org}`).toBe(id);

      // Gate (b) — the TRUST ANCHOR. This is the seam S3 changed: the anchor
      // resolution was exact-org, so it returned null for every organization.
      const exactOrg = await (await installAnchor.makeDefaultInstallAnchorResolver(org, "exact-org"))(WS_PKG);
      expect(exactOrg, `exact-org anchor for ${org} (the pre-S3 gap)`).toBeNull();

      const resolved = await (
        await installAnchor.makeDefaultInstallAnchorResolver(org, "org-then-workspace")
      )(WS_PKG);
      expect(resolved, `org-then-workspace anchor for ${org}`).not.toBeNull();
      expect(resolved!.installId).toBe(id);
      // The anchor binds the WORKSPACE row's own scope, never the actor's org.
      expect(resolved!.orgId).toBeNull();
      expect(resolved!.digest).toBe(digest);
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2 — org + workspace coexistence: the org row wins for ITS org
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("cinatra#2697 AC-2 — coexistence: the org row wins, the workspace row serves the rest", () => {
  async function seedCoexistence(): Promise<{ orgRowId: string; wsRowId: string }> {
    const wsRowId = await installConnectorAtAnchor(workspaceAnchor(), BOTH_PKG, {
      digest: "sha256-digest-ws",
    });
    const orgRowId = await installConnectorAtAnchor(
      anchors.actorDerivedRowAnchor(ORG_A),
      BOTH_PKG,
      { digest: "sha256-digest-orga" },
    );
    return { orgRowId, wsRowId };
  }

  it("the DB holds both rows — the org-NULL identity index keys them apart", async () => {
    const { orgRowId, wsRowId } = await seedCoexistence();
    const res = await client.query(
      `SELECT id, owner_level, organization_id FROM "${q(TEST_SCHEMA)}"."installed_extension"
       WHERE package_name = $1 ORDER BY organization_id NULLS LAST`,
      [BOTH_PKG],
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r) => r.id).sort()).toEqual([orgRowId, wsRowId].sort());
  });

  it("the async resolver gives org A its OWN row and org B the workspace row", async () => {
    const { orgRowId, wsRowId } = await seedCoexistence();
    expect((await resourceIdentity.resolveConnectorResource(ORG_A, BOTH_PKG))?.resourceId).toBe(orgRowId);
    expect((await resourceIdentity.resolveConnectorResource(ORG_B, BOTH_PKG))?.resourceId).toBe(wsRowId);
  });

  it("the SYNC resolver gives org A its OWN row and org B the workspace row", async () => {
    const { orgRowId, wsRowId } = await seedCoexistence();
    const a = syncResolver.resolveConnectorCanonicalAccessSync(ORG_A, BOTH_PKG);
    const b = syncResolver.resolveConnectorCanonicalAccessSync(ORG_B, BOTH_PKG);
    if (a.status !== "found" || b.status !== "found") throw new Error("expected both found");
    expect(a.access.resourceId).toBe(orgRowId);
    expect(a.access.owner.organizationId).toBe(ORG_A);
    expect(b.access.resourceId).toBe(wsRowId);
    expect(b.access.owner.organizationId).toBeNull();
  });

  it("each org resolves ITS OWN row's access policy — the two never blend", async () => {
    const { orgRowId, wsRowId } = await seedCoexistence();
    await accessContract.setExtensionInstallAccess({
      kind: "connector",
      resourceId: wsRowId,
      policy: contract.resolveInstallAccessTargetContract({ level: "workspace", id: ORG_A }, ORG_A).policy,
      installedByUserId: "u-workspace",
    });
    await accessContract.setExtensionInstallAccess({
      kind: "connector",
      resourceId: orgRowId,
      policy: contract.resolveInstallAccessTargetContract({ level: "admin", id: ORG_A }, ORG_A).policy,
      installedByUserId: "u-org-a",
    });

    const a = syncResolver.resolveConnectorCanonicalAccessSync(ORG_A, BOTH_PKG);
    const b = syncResolver.resolveConnectorCanonicalAccessSync(ORG_B, BOTH_PKG);
    if (a.status !== "found" || b.status !== "found") throw new Error("expected both found");
    expect(a.access.policy?.runListVisibility).toEqual(["admin"]);
    expect(a.access.installedByUserId).toBe("u-org-a");
    expect(b.access.policy?.runListVisibility).toEqual(["workspace"]);
    expect(b.access.installedByUserId).toBe("u-workspace");
  });

  it("the trust anchor follows the same rule: org A anchors ITS row, org B the workspace row", async () => {
    const { orgRowId, wsRowId } = await seedCoexistence();
    for (const [org, digest] of [
      [ORG_A, "sha256-digest-orga"],
      [null, "sha256-digest-ws"],
    ] as const) {
      await installOps.beginInstallOp({
        installOpId: `op-${randomUUID().slice(0, 8)}`,
        packageName: BOTH_PKG,
        orgId: org,
        phase: "materialized",
        digest,
        version: "1.0.0",
      });
      const op = await installOps.readInstallOp(BOTH_PKG, org);
      await installOps.finalizeInstallOp(op!.installOpId);
    }

    const a = await (await installAnchor.makeDefaultInstallAnchorResolver(ORG_A, "org-then-workspace"))(BOTH_PKG);
    expect(a?.installId).toBe(orgRowId);
    expect(a?.orgId).toBe(ORG_A);

    const b = await (await installAnchor.makeDefaultInstallAnchorResolver(ORG_B, "org-then-workspace"))(BOTH_PKG);
    expect(b?.installId).toBe(wsRowId);
    expect(b?.orgId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC-3 — bundled/system connector behavior is unchanged
// ---------------------------------------------------------------------------

describe.skipIf(!HAS_DB)("cinatra#2697 AC-3 — bundled/system connectors keep their existing path", () => {
  const bundledSource = {
    type: "bundled" as const,
    packageName: BUNDLED_PKG,
    version: "0.1.0",
  };

  async function installBundledPlatformAnchor(): Promise<string> {
    return installConnectorAtAnchor(
      { ownerLevel: "platform", ownerId: "__platform__", organizationId: null },
      BUNDLED_PKG,
      { source: bundledSource },
    );
  }

  it("a platform static-bundle anchor still installs (unchanged)", async () => {
    const id = await installBundledPlatformAnchor();
    const res = await client.query(
      `SELECT owner_level, organization_id FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE id = $1`,
      [id],
    );
    expect(res.rows[0]).toEqual({ owner_level: "platform", organization_id: null });
  });

  it("neither connector-access resolver resolves a bundled PLATFORM anchor — exactly as before S3", async () => {
    await installBundledPlatformAnchor();
    for (const org of [ORG_A, ORG_B]) {
      expect(await resourceIdentity.resolveConnectorResource(org, BUNDLED_PKG), org).toBeNull();
      expect(syncResolver.resolveConnectorCanonicalAccessSync(org, BUNDLED_PKG).status, org).toBe("absent");
    }
  });

  it("a bundled platform anchor does NOT satisfy the workspace fallback (the relaxation is narrow)", async () => {
    await installBundledPlatformAnchor();
    const rows = await canonicalStore.readInstalledExtensionsByPackageName(BUNDLED_PKG);
    // The workspace pick is owner_level='workspace' ONLY — a platform anchor at
    // the same org-NULL scope is not it, and must not make the pick ambiguous.
    expect(installAnchor.pickSingleWorkspaceAnchoredActiveRow(rows)).toBeNull();
    // …while the platform-global pick (the boot path) still resolves it.
    expect(installAnchor.pickSingleLiveRowAcrossOrgs(rows)?.ownerLevel).toBe("platform");
  });

  it("a non-bundled PLATFORM connector is still refused at the install chokepoint", async () => {
    await expect(
      installConnectorAtAnchor(
        { ownerLevel: "platform", ownerId: "__platform__", organizationId: null },
        BUNDLED_PKG,
      ),
    ).rejects.toThrow(/connector install must be organization-anchored/);
  });
});
