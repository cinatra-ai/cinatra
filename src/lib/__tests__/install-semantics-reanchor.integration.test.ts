/**
 * THE DB-LAYER PROOF of the §V RE-ANCHOR (cinatra#2694 / S5 #2802) — widening to
 * "Workspace: All", narrowing back, and every refusal, driven against a REAL
 * Postgres through the REAL canonical store and the REAL lifecycle primitive.
 *
 * Owner ruling 2026-08-16 (entry 350): "§V re-anchors". Saving the settings
 * page's access picker MOVES the canonical row's anchor. The unit suites pin the
 * arithmetic; this suite answers what they cannot — against the real partial
 * unique indexes and the real platform-invariant CHECK:
 *
 *   - SAME ID: widening and narrowing keep the row's id, its created_at, its
 *     access policy, its co-owners and its declared dependency edges;
 *   - ATOMIC: the anchor move, the access-policy write, the S4 supersession and
 *     the dependency-edge re-resolution land in ONE transaction;
 *   - IDENTITY / DEFAULT SLOTS: a taken destination slot refuses `anchor_conflict`
 *     — including when the occupant is ARCHIVED — and a bundled `platform` row
 *     coexists with the re-anchored `workspace` row;
 *   - CLOSURE: a narrowing that would strand a dependent's REQUIRED edge refuses
 *     and unwinds completely;
 *   - ZERO WRITES on every refusal (full raw-row + policy-row snapshots compared);
 *   - the READERS (identity read, effective-row rule, lifecycle target resolver)
 *     return the MOVED row on a fresh read, with no activation and no
 *     re-registration anywhere in the path.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm test:install-semantics
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Actor } from "@cinatra-ai/extension-types";

const TEST_SCHEMA = "cinatra_test_install_semantics_2802";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

const ORG_A = "org-2802-a";
const ORG_B = "org-2802-b";
const ORG_C = "org-2802-c";
const PKG = "@cinatra-ai/ws-artifact-2802";
const PKG_DEP = "@cinatra-ai/dep-artifact-2802";
const PKG_DEPENDENT = "@cinatra-ai/dependent-artifact-2802";
const PKG_CONNECTOR = "@cinatra-ai/ws-connector-2802";
const ALL_PKGS = [PKG, PKG_DEP, PKG_DEPENDENT, PKG_CONNECTOR];

let canonicalStore: typeof import("@cinatra-ai/extensions/canonical-store");
let lifecycle: typeof import("@cinatra-ai/extensions/lifecycle-primitive");
let resolver: typeof import("@cinatra-ai/extensions/lifecycle-target-resolver");
let types: typeof import("@cinatra-ai/extensions/canonical-types");
let client: Client;

type RawRow = Record<string, unknown>;

/** The PLATFORM ADMIN whose §V save re-anchors the row. */
const platformAdmin: Actor = {
  actorType: "human",
  source: "ui",
  userId: "u-2802",
  orgId: ORG_A,
  platformRole: "platform_admin",
} as Actor;

const WORKSPACE_ANCHOR = {
  ownerLevel: "workspace",
  ownerId: "__platform__",
  organizationId: null,
} as const;
const PLATFORM_ANCHOR = {
  ownerLevel: "platform",
  ownerId: "__platform__",
  organizationId: null,
} as const;
const orgAnchor = (orgId: string) =>
  ({ ownerLevel: "organization", ownerId: orgId, organizationId: orgId }) as const;

function policyFor(...tokens: string[]) {
  return {
    runListVisibility: tokens,
    runDataVisibility: tokens,
    runExecuteVisibility: tokens,
    allowRunSharing: false,
  };
}

async function rawRowById(id: string): Promise<RawRow | null> {
  const res = await client.query(
    `SELECT * FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE id = $1`,
    [id],
  );
  return (res.rows[0] as RawRow | undefined) ?? null;
}

/** Every canonical row of the fixture packages — the ZERO-WRITES snapshot. */
async function snapshotRows(): Promise<RawRow[]> {
  const res = await client.query(
    `SELECT * FROM "${q(TEST_SCHEMA)}"."installed_extension"
     WHERE package_name = ANY($1) ORDER BY id`,
    [ALL_PKGS],
  );
  return res.rows as RawRow[];
}

async function snapshotEdges(): Promise<RawRow[]> {
  const res = await client.query(
    `SELECT dependent_install_id, declared_package_name, requirement, resolved_install_id
     FROM "${q(TEST_SCHEMA)}"."extension_dependency_edge"
     ORDER BY dependent_install_id, declared_package_name`,
  );
  return res.rows as RawRow[];
}

async function snapshotPolicies(): Promise<RawRow[]> {
  const res = await client.query(
    `SELECT resource_kind, resource_id, policy, installed_by_user_id
     FROM "${q(TEST_SCHEMA)}"."extension_access_policy" ORDER BY resource_id`,
  );
  return res.rows as RawRow[];
}

async function snapshotCoOwners(): Promise<RawRow[]> {
  const res = await client.query(
    `SELECT resource_kind, resource_id, user_id, granted_by
     FROM "${q(TEST_SCHEMA)}"."extension_co_owners" ORDER BY resource_id, user_id`,
  );
  return res.rows as RawRow[];
}

/** The identity triple — what "the SAME row, moved" means, exactly. */
function anchorOf(raw: RawRow | null): unknown {
  return raw === null
    ? null
    : {
        owner_level: raw.owner_level,
        organization_id: raw.organization_id,
        owner_id: raw.owner_id,
      };
}

function source(packageName: string, version: string) {
  return {
    type: "verdaccio" as const,
    registryUrl: "http://localhost:4873",
    packageName,
    version,
    integrity: "sha512-real-2802",
  };
}

/** Install a canonical row AT AN EXACT ANCHOR — the real primitive. */
async function installAtAnchor(
  anchor: { ownerLevel: string; ownerId: string | null; organizationId: string | null },
  over: {
    packageName?: string;
    version?: string;
    kind?: string;
    status?: string;
    dependencies?: unknown[];
  } = {},
): Promise<string> {
  const packageName = over.packageName ?? PKG;
  const id = `iext_${randomUUID().slice(0, 12)}`;
  await lifecycle.installExtensionManifest(
    {
      id,
      packageName,
      ownerLevel: anchor.ownerLevel as never,
      ownerId: anchor.ownerId,
      organizationId: anchor.organizationId,
      kind: (over.kind ?? "artifact") as never,
      source: source(packageName, over.version ?? "1.0.0") as never,
      requiredInProd: false,
      dependencies: (over.dependencies ?? []) as never,
      manifestHash: null,
      status: "active" as never,
    } as never,
    { actor: { source: "dispatcher", userId: "u-2802" }, reason: "cinatra#2802 fixture" },
  );
  // An ARCHIVED fixture row is installed live and then archived THROUGH the
  // primitive — the install path refuses to create a row already archived, and
  // an archived row is exactly what a superseded organization row is.
  if (over.status === "archived") {
    await lifecycle.transitionExtensionLifecycle(id, "archive", {
      actor: { source: "test", userId: "u-2802" },
      reason: "cinatra#2802 fixture",
    });
  }
  return id;
}

/** Seed the polymorphic access rows the re-anchor must preserve / rewrite. */
async function seedAccess(resourceKind: string, resourceId: string, tokens: string[]) {
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."extension_access_policy"
       (resource_kind, resource_id, policy, installed_by_user_id, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (resource_kind, resource_id) DO UPDATE SET policy = EXCLUDED.policy`,
    [resourceKind, resourceId, JSON.stringify(policyFor(...tokens)), "u-2802"],
  );
  await client.query(
    `INSERT INTO "${q(TEST_SCHEMA)}"."extension_co_owners"
       (resource_kind, resource_id, user_id, granted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (resource_kind, resource_id, user_id) DO NOTHING`,
    [resourceKind, resourceId, "co-owner-2802", "u-2802"],
  );
}

/** The re-anchor under test, as the §V save performs it. */
async function reanchor(
  rowId: string,
  destination: { ownerLevel: string; ownerId: string | null; organizationId: string | null },
  tokens: string[],
  resourceKind = "artifact",
) {
  return lifecycle.reanchorInstallRow({
    rowId,
    resourceKind,
    destination: destination as never,
    policy: policyFor(...tokens),
  });
}

async function refusalCodeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "no-refusal";
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (
      head !== "CREATE" &&
      head !== "ALTER " &&
      head !== "DROP T" &&
      head !== "DROP S" &&
      head !== "DO $$"
    )
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
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  canonicalStore = await import("@cinatra-ai/extensions/canonical-store");
  lifecycle = await import("@cinatra-ai/extensions/lifecycle-primitive");
  resolver = await import("@cinatra-ai/extensions/lifecycle-target-resolver");
  types = await import("@cinatra-ai/extensions/canonical-types");

  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

beforeEach(async () => {
  if (!HAS_DB) return;
  // Per-test cleanup THROUGH THE PRIMITIVE — never a raw write against
  // installed_extension (the canonical-gate drift guard confines those to the
  // store + DDL).
  // Drop the fixture EDGES first: a still-bound dependent legitimately blocks
  // the row teardown, and the fixtures deliberately create such bindings.
  await client.query(
    `DELETE FROM "${q(TEST_SCHEMA)}"."extension_dependency_edge"
     WHERE dependent_install_id IN (
       SELECT id FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE package_name = ANY($1)
     )`,
    [ALL_PKGS],
  );
  for (const pkg of ALL_PKGS) {
    for (const row of await canonicalStore.readInstalledExtensionsByPackageName(pkg)) {
      // A `locked` fixture row rejects every destructive op, so unlock it first
      // (the sanctioned platform-admin path) rather than reach past the matrix.
      if (row.status === "locked") {
        await lifecycle.transitionExtensionLifecycle(row.id, "unlock", {
          actor: { source: "test", userId: "u-2802", roles: ["platform_admin"] },
          reason: "cinatra#2802 fixture teardown",
          allowUnlock: true,
        });
      }
      await lifecycle.deleteScopedCanonicalRow(row.id);
    }
  }
  await client.query(`DELETE FROM "${q(TEST_SCHEMA)}"."extension_access_policy"`);
  await client.query(`DELETE FROM "${q(TEST_SCHEMA)}"."extension_co_owners"`);
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2802 — widening to Workspace: All", () => {
  it("moves the SAME row to the workspace anchor and supersedes the other organizations", async () => {
    const movedId = await installAtAnchor(orgAnchor(ORG_A));
    const otherOrgId = await installAtAnchor(orgAnchor(ORG_B));
    const bundledId = await installAtAnchor(PLATFORM_ANCHOR);
    await seedAccess("artifact", movedId, [`org:${ORG_A}`]);
    await seedAccess("artifact", otherOrgId, [`org:${ORG_B}`]);

    const before = await rawRowById(movedId);
    const bundledBefore = await rawRowById(bundledId);
    const otherBefore = await rawRowById(otherOrgId);

    const outcome = await reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]);

    // SAME ID. Same created_at. New anchor.
    expect(outcome.row.id).toBe(movedId);
    expect(outcome.anchorMoved).toBe(true);
    const after = await rawRowById(movedId);
    expect(anchorOf(after)).toEqual({
      owner_level: "workspace",
      organization_id: null,
      owner_id: "__platform__",
    });
    expect(after!.created_at).toEqual(before!.created_at);
    expect(after!.version).toEqual(before!.version);
    expect(after!.is_default).toEqual(before!.is_default);
    expect(after!.source).toEqual(before!.source);
    expect(after!.status).toBe("active");

    // SUPERSESSION, in place: the OTHER organization's row is archived and
    // everything else about it is byte-identical.
    expect(outcome.supersededRowIds).toEqual([otherOrgId]);
    const otherAfter = await rawRowById(otherOrgId);
    expect(otherAfter!.status).toBe("archived");
    expect(anchorOf(otherAfter)).toEqual(anchorOf(otherBefore));
    expect(otherAfter!.id).toBe(otherOrgId);
    expect(otherAfter!.source).toEqual(otherBefore!.source);

    // Its access rows survive the supersession untouched.
    const policies = await snapshotPolicies();
    expect(policies.find((p) => p.resource_id === otherOrgId)!.policy).toEqual(
      policyFor(`org:${ORG_B}`),
    );
    expect((await snapshotCoOwners()).map((c) => c.resource_id).sort()).toEqual(
      [movedId, otherOrgId].sort(),
    );

    // The BUNDLED platform anchor coexists with the workspace row, untouched.
    expect(await rawRowById(bundledId)).toEqual(bundledBefore);

    // The audience landed with the anchor.
    expect(policies.find((p) => p.resource_id === movedId)!.policy).toEqual(
      policyFor("workspace"),
    );
    // The installer pointer is never transferred by a re-anchor.
    expect(policies.find((p) => p.resource_id === movedId)!.installed_by_user_id).toBe("u-2802");
  });

  it("makes the moved row the one the readers resolve, on a fresh read", async () => {
    const movedId = await installAtAnchor(orgAnchor(ORG_A));
    await installAtAnchor(orgAnchor(ORG_B));
    await reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]);

    // Identity read at the workspace anchor returns the MOVED row.
    const byIdentity = await canonicalStore.readInstalledExtensionByIdentity(
      types.workspaceAnchorIdentity(PKG),
    );
    expect(byIdentity?.id).toBe(movedId);

    // The effective-row rule collapses to it.
    const rows = await canonicalStore.readInstalledExtensionsByPackageName(PKG);
    expect(resolver.findLiveWorkspaceRow(rows)?.id).toBe(movedId);
    expect(resolver.effectiveInstallRows(rows).map((r) => r.id)).toEqual([movedId]);

    // The lifecycle target resolver — the same IO wrapper the dispatcher calls.
    const target = await resolver.resolveLifecycleTargetRow(PKG, platformAdmin, null as never);
    expect(target.id).toBe(movedId);
  });

  it("is a no-op re-save when the row already sits at the workspace anchor", async () => {
    const movedId = await installAtAnchor(WORKSPACE_ANCHOR);
    const archivedOrgId = await installAtAnchor(orgAnchor(ORG_B), { status: "archived" });

    const outcome = await reanchor(movedId, WORKSPACE_ANCHOR, ["admin"]);
    expect(outcome.anchorMoved).toBe(false);
    expect(outcome.supersededRowIds).toEqual([]);
    expect((await rawRowById(archivedOrgId))!.status).toBe("archived");
    expect((await snapshotPolicies())[0]!.policy).toEqual(policyFor("admin"));
  });

  it("leaves a LOCKED organization row locked", async () => {
    const movedId = await installAtAnchor(orgAnchor(ORG_A));
    const lockedId = await installAtAnchor(orgAnchor(ORG_B));
    await lifecycle.transitionExtensionLifecycle(lockedId, "lock", {
      actor: { source: "test", userId: "u-2802" },
      reason: "cinatra#2802 fixture",
    });

    const outcome = await reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]);
    expect(outcome.supersededRowIds).toEqual([]);
    expect((await rawRowById(lockedId))!.status).toBe("locked");
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2802 — narrowing back to one organization", () => {
  it("moves the SAME row to the destination organization and leaves archived rows archived", async () => {
    const movedId = await installAtAnchor(orgAnchor(ORG_A));
    const otherOrgId = await installAtAnchor(orgAnchor(ORG_B));
    await seedAccess("artifact", movedId, [`org:${ORG_A}`]);
    await reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]);
    expect((await rawRowById(otherOrgId))!.status).toBe("archived");

    // Narrow to a CONFLICT-FREE organization.
    const outcome = await reanchor(movedId, orgAnchor(ORG_C), [`org:${ORG_C}`]);
    expect(outcome.row.id).toBe(movedId);
    expect(anchorOf(await rawRowById(movedId))).toEqual({
      owner_level: "organization",
      organization_id: ORG_C,
      owner_id: ORG_C,
    });
    // Nothing revives by itself (S4, change 4).
    expect((await rawRowById(otherOrgId))!.status).toBe("archived");
    expect((await snapshotPolicies()).find((p) => p.resource_id === movedId)!.policy).toEqual(
      policyFor(`org:${ORG_C}`),
    );
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2802 — the destination slot, ARCHIVED rows included", () => {
  it("refuses an ARCHIVED occupant of the destination organization and writes nothing", async () => {
    const movedId = await installAtAnchor(WORKSPACE_ANCHOR);
    await installAtAnchor(orgAnchor(ORG_B), { status: "archived" });
    await seedAccess("artifact", movedId, ["workspace"]);

    const rowsBefore = await snapshotRows();
    const policiesBefore = await snapshotPolicies();
    const edgesBefore = await snapshotEdges();

    expect(await refusalCodeOf(() => reanchor(movedId, orgAnchor(ORG_B), [`org:${ORG_B}`]))).toBe(
      "anchor_conflict",
    );

    expect(await snapshotRows()).toEqual(rowsBefore);
    expect(await snapshotPolicies()).toEqual(policiesBefore);
    expect(await snapshotEdges()).toEqual(edgesBefore);
  });

  it("refuses when a workspace row of the same version already exists", async () => {
    const movedId = await installAtAnchor(orgAnchor(ORG_A));
    await installAtAnchor(WORKSPACE_ANCHOR);
    const rowsBefore = await snapshotRows();

    expect(await refusalCodeOf(() => reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]))).toBe(
      "anchor_conflict",
    );
    expect(await snapshotRows()).toEqual(rowsBefore);
  });

  it("refuses the ONE-DEFAULT slot when a different version already holds it", async () => {
    const movedId = await installAtAnchor(orgAnchor(ORG_A), { version: "1.0.0" });
    await installAtAnchor(WORKSPACE_ANCHOR, { version: "2.0.0" });
    const rowsBefore = await snapshotRows();

    expect(await refusalCodeOf(() => reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]))).toBe(
      "anchor_conflict",
    );
    expect(await snapshotRows()).toEqual(rowsBefore);
  });

  it("admits the workspace destination beside a BUNDLED platform row (the CHECK and the indexes agree)", async () => {
    const movedId = await installAtAnchor(orgAnchor(ORG_A));
    const bundledId = await installAtAnchor(PLATFORM_ANCHOR);

    await reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]);

    // Both org-NULL rows coexist: the org-NULL identity index keys on owner_level.
    const rows = await canonicalStore.readInstalledExtensionsByPackageName(PKG);
    expect(rows.filter((r) => r.organizationId === null).map((r) => r.id).sort()).toEqual(
      [movedId, bundledId].sort(),
    );
    expect((await rawRowById(movedId))!.owner_id).toBe("__platform__");
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2802 — dependency edges", () => {
  const requiredEdge = (packageName: string) => ({
    packageName,
    edgeType: "runtime" as const,
    requirement: "required" as const,
    versionConstraint: { kind: "semver-range" as const, range: "*" },
  });
  const optionalEdge = (packageName: string) => ({
    packageName,
    edgeType: "runtime" as const,
    requirement: "optional" as const,
    versionConstraint: { kind: "semver-range" as const, range: "*" },
  });

  it("re-resolves the moved row's OUTGOING edges under its new scope", async () => {
    await installAtAnchor(orgAnchor(ORG_A), { packageName: PKG_DEP });
    const movedId = await installAtAnchor(orgAnchor(ORG_A), {
      dependencies: [optionalEdge(PKG_DEP)],
    });
    const edgesBefore = (await snapshotEdges()).filter((e) => e.dependent_install_id === movedId);
    expect(edgesBefore[0]!.resolved_install_id).not.toBeNull();

    await reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]);

    // The row is org-NULL now, so its own-org arm is gone: the OPTIONAL edge
    // re-resolves to nothing, and the DECLARED edge survives (declared_package_name).
    const edgesAfter = (await snapshotEdges()).filter((e) => e.dependent_install_id === movedId);
    expect(edgesAfter).toHaveLength(1);
    expect(edgesAfter[0]!.declared_package_name).toBe(PKG_DEP);
    expect(edgesAfter[0]!.resolved_install_id).toBeNull();
  });

  it("re-resolves the INCOMING edges pinned to the moved row", async () => {
    const movedId = await installAtAnchor(orgAnchor(ORG_A));
    const dependentId = await installAtAnchor(orgAnchor(ORG_A), {
      packageName: PKG_DEPENDENT,
      dependencies: [requiredEdge(PKG)],
    });
    const before = (await snapshotEdges()).find((e) => e.dependent_install_id === dependentId);
    expect(before!.resolved_install_id).toBe(movedId);

    await reanchor(movedId, WORKSPACE_ANCHOR, ["workspace"]);

    // Still resolved — through the org-NULL (platform) arm, to the SAME row.
    const after = (await snapshotEdges()).find((e) => e.dependent_install_id === dependentId);
    expect(after!.resolved_install_id).toBe(movedId);
  });

  it("refuses a narrowing that would strand a dependent's REQUIRED edge, atomically", async () => {
    const movedId = await installAtAnchor(WORKSPACE_ANCHOR);
    const dependentId = await installAtAnchor(orgAnchor(ORG_A), {
      packageName: PKG_DEPENDENT,
      dependencies: [requiredEdge(PKG)],
    });
    expect(
      (await snapshotEdges()).find((e) => e.dependent_install_id === dependentId)!
        .resolved_install_id,
    ).toBe(movedId);

    const rowsBefore = await snapshotRows();
    const edgesBefore = await snapshotEdges();

    expect(await refusalCodeOf(() => reanchor(movedId, orgAnchor(ORG_B), [`org:${ORG_B}`]))).toBe(
      "closure_broken",
    );

    expect(await snapshotRows()).toEqual(rowsBefore);
    expect(await snapshotEdges()).toEqual(edgesBefore);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2802 — the connector ceiling round-trips the canonical row", () => {
  it("caps the audience at the cached access declaration", async () => {
    const connectorId = await installAtAnchor(orgAnchor(ORG_A), {
      packageName: PKG_CONNECTOR,
      kind: "connector",
    });
    await lifecycle.recordExtensionAccessDeclaration(
      connectorId,
      { formatVersion: 1, mode: "only", scope: "organization", source: "declared" } as never,
      { actor: { source: "test", userId: "u-2802" }, reason: "cinatra#2802 fixture" },
    );

    // The DECLARATION is what the §V validator reads back — from the row, not
    // from a connection identity.
    const row = await canonicalStore.readInstalledExtensionById(connectorId);
    const declaration = row!.accessDeclaration!;
    expect(types.isResolvedConnectorAccessDeclaration(declaration)).toBe(true);

    // A workspace audience EXCEEDS an `only: organization` ceiling…
    expect(
      types.installedAudienceWithinDeclaredCeiling("workspace", declaration.scope, null),
    ).toBe(false);
    // …and the organization audience at the destination does not.
    expect(
      types.installedAudienceWithinDeclaredCeiling(`org:${ORG_A}`, declaration.scope, ORG_A),
    ).toBe(true);
  });
});
