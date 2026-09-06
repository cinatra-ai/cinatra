/**
 * THE DB-LAYER PROOF of the row-identity lifecycle (cinatra#2694 / S4 #2698) —
 * update, archive, restore and reinstall driven against a REAL Postgres through
 * the REAL addressing rule, the REAL canonical store and the REAL lifecycle
 * primitive.
 *
 * The unit suites pin the addressing rule and each threading hop. This suite
 * answers what they cannot: after each operation, is the row still the SAME
 * row — same `(organization_id, owner_level, owner_id)` — and is the OTHER row
 * for the same package still byte-identical?
 *
 * Asserted here (S4's acceptance, at the DB layer):
 *   - update / archive / restore / reinstall each round-trip a WORKSPACE-anchored
 *     row without re-anchoring it (one fixture per operation);
 *   - the same four operations on an ORG-anchored row are byte-identical to
 *     today (regression fixtures, run through the SAME code path);
 *   - THE EFFECTIVE ROW (owner ruling 2026-08-16): a live workspace row
 *     supersedes every organization row — a platform admin resolves it with no
 *     selector at all, an organization owner resolves nothing, and an archived
 *     organization row is never a candidate;
 *   - SUPERSESSION ON INSTALL: the organization row is archived IN PLACE, with
 *     its id, anchor, provenance, dependency edges and access policy retained
 *     (byte-level column comparison) — the ordinary uninstall/teardown hooks
 *     never run;
 *   - REVERSE INSTALLS REFUSED: the install boundary refuses an
 *     organization-anchored install while a live workspace row exists;
 *   - NO AUTOMATIC REVIVAL: removing the workspace install leaves the
 *     organization row archived, and only then addressable for an ordinary
 *     guarded restore;
 *   - the SERVER-MINTED anchor-tier selector still separates a product-installed
 *     workspace row from a bundled platform anchor at the same org-NULL scope —
 *     the one genuine same-scope identity ambiguity that survives.
 *
 * Each operation is expressed exactly as the dispatcher expresses it:
 *   archive   → transitionExtensionLifecycle(resolvedRow.id, "archive")
 *   restore   → transitionExtensionLifecycle(resolvedRow.id, "activate")
 *   update    → sourceSwitchExtension(resolvedRow.id, newSource) — "identity
 *               preserved, provenance replaced", with lifecycleRowAnchor
 *               asserted to be the row's own tuple
 *   reinstall → deleteScopedCanonicalRow(resolvedRow.id) then a fresh install at
 *               the CAPTURED anchor (uninstall-then-install, anchor threaded)
 * — and the row is always found through `resolveLifecycleTargetRow`, the same
 * IO wrapper the dispatcher calls, so nothing here re-implements the rule.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm test:install-semantics
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Actor } from "@cinatra-ai/extension-types";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const TEST_SCHEMA = "cinatra_test_install_semantics_2698";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const q = (s: string) => s.replaceAll('"', '""');

const ORG = "org-2698-a";
const PKG = "@cinatra-ai/ws-artifact-2698";
const PKG_BUNDLED = "@cinatra-ai/bundled-artifact-2698";
const ALL_PKGS = [PKG, PKG_BUNDLED];

let canonicalStore: typeof import("@cinatra-ai/extensions/canonical-store");
let lifecycle: typeof import("@cinatra-ai/extensions/lifecycle-primitive");
let resolver: typeof import("@cinatra-ai/extensions/lifecycle-target-resolver");
let client: Client;

type RawRow = Record<string, unknown>;

/** The PLATFORM ADMIN who installed at "Workspace: All" — with an active
 *  organization, which is the session such an install is made from. */
const platformAdmin: Actor = {
  actorType: "human",
  source: "ui",
  userId: "u-2698",
  orgId: ORG,
  platformRole: "platform_admin",
} as Actor;

/** An organization owner — no platform standing. */
const orgOwner: Actor = {
  actorType: "human",
  source: "ui",
  userId: "u-2698-org",
  orgId: ORG,
  orgRole: "org_owner",
} as Actor;

const WORKSPACE_ANCHOR = {
  ownerLevel: "workspace",
  ownerId: "__platform__",
  organizationId: null,
} as const;
const ORG_ANCHOR = {
  ownerLevel: "organization",
  ownerId: ORG,
  organizationId: ORG,
} as const;
const PLATFORM_ANCHOR = {
  ownerLevel: "platform",
  ownerId: "__platform__",
  organizationId: null,
} as const;

async function rawRows(packageName: string): Promise<RawRow[]> {
  const res = await client.query(
    `SELECT * FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE package_name = $1 ORDER BY id`,
    [packageName],
  );
  return res.rows as RawRow[];
}

async function rawRowById(id: string): Promise<RawRow | null> {
  const res = await client.query(
    `SELECT * FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE id = $1`,
    [id],
  );
  return (res.rows[0] as RawRow | undefined) ?? null;
}

/** The identity triple — what "without re-anchoring it" means, exactly. */
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
    integrity: "sha512-real-2698",
  };
}

/** Install a canonical row AT AN EXACT ANCHOR — the real primitive, the same
 *  call `syncCanonicalManifestInstall` makes. */
async function installAtAnchor(
  anchor: { ownerLevel: string; ownerId: string | null; organizationId: string | null },
  over: { packageName?: string; version?: string } = {},
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
      kind: "artifact" as never,
      source: source(packageName, over.version ?? "1.0.0") as never,
      requiredInProd: false,
      dependencies: [],
      manifestHash: null,
      status: "active",
    } as never,
    { actor: { source: "dispatcher", userId: "u-2698" }, reason: "cinatra#2698 fixture" },
  );
  return id;
}

// ---------------------------------------------------------------------------
// The four operations, expressed as the dispatcher expresses them — each one
// resolving its target through `resolveLifecycleTargetRow` first.
// ---------------------------------------------------------------------------

async function archiveOp(
  actor: Actor,
  selector?: { ownerLevel: string } | null,
): Promise<string> {
  const row = await resolver.resolveLifecycleTargetRow(PKG, actor, selector as never);
  await lifecycle.transitionExtensionLifecycle(row.id, "archive", {
    actor: { source: "dispatcher", userId: actor.userId },
    reason: resolver.lifecycleTransitionLabel(actor, "archive", row),
  });
  return row.id;
}

async function restoreOp(
  actor: Actor,
  selector?: { ownerLevel: string } | null,
): Promise<string> {
  const row = await resolver.resolveLifecycleTargetRow(PKG, actor, selector as never);
  await lifecycle.transitionExtensionLifecycle(row.id, "activate", {
    actor: { source: "dispatcher", userId: actor.userId },
    reason: resolver.lifecycleTransitionLabel(actor, "activate", row),
  });
  return row.id;
}

/** UPDATE — the recreate that must preserve the row's OWN anchor. The
 *  dispatcher re-runs the real-integrity pipeline against the row it resolved
 *  and rewrites that row's provenance in place; `sourceSwitchExtension` is the
 *  primitive that expresses exactly that ("identity preserved, provenance
 *  replaced"), so the fixture drives the update through it. The anchor the
 *  dispatcher would hand the pipeline (`lifecycleRowAnchor`) is asserted to be
 *  the row's own, before and after. */
async function updateOp(
  actor: Actor,
  version: string,
  selector?: { ownerLevel: string } | null,
): Promise<string> {
  const row = await resolver.resolveLifecycleTargetRow(PKG, actor, selector as never);
  const anchor = resolver.lifecycleRowAnchor(row);
  expect(anchor).toEqual({
    ownerLevel: row.ownerLevel,
    ownerId: row.ownerId,
    organizationId: row.organizationId,
  });
  await lifecycle.sourceSwitchExtension(row.id, source(PKG, version) as never, {
    actor: { source: "dispatcher", userId: actor.userId },
    reason: "cinatra#2698 update",
  });
  return row.id;
}

/** REINSTALL — uninstall THEN install. The install leg lands at the anchor
 *  CAPTURED from the row before it was removed (never the actor's scope). */
async function reinstallOp(
  actor: Actor,
  version: string,
  selector?: { ownerLevel: string } | null,
): Promise<string> {
  const row = await resolver.resolveLifecycleTargetRow(PKG, actor, selector as never);
  const anchor = resolver.lifecycleRowAnchor(row);
  await lifecycle.deleteScopedCanonicalRow(row.id);
  return installAtAnchor(anchor, { version });
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
  resolver = await import("@cinatra-ai/extensions/lifecycle-target-resolver");

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
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

beforeEach(async () => {
  if (!HAS_DB) return;
  // Per-test cleanup THROUGH THE PRIMITIVE — never a raw write against
  // installed_extension (the canonical-gate drift guard confines those to the
  // store + DDL).
  for (const pkg of ALL_PKGS) {
    for (const row of await canonicalStore.readInstalledExtensionsByPackageName(pkg)) {
      await lifecycle.deleteScopedCanonicalRow(row.id);
    }
  }
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2698 — a workspace-anchored row round-trips every operation", () => {
  it("ARCHIVE transitions the workspace row and leaves its anchor alone", async () => {
    const id = await installAtAnchor(WORKSPACE_ANCHOR);
    const before = anchorOf(await rawRowById(id));

    expect(await archiveOp(platformAdmin)).toBe(id);

    const after = await rawRowById(id);
    expect(after?.status).toBe("archived");
    expect(anchorOf(after)).toEqual(before);
    expect(anchorOf(after)).toEqual({
      owner_level: "workspace",
      organization_id: null,
      owner_id: "__platform__",
    });
    // Exactly one row for the package — the archive created nothing.
    expect(await rawRows(PKG)).toHaveLength(1);
  });

  it("RESTORE re-activates the workspace row at its OWN anchor, never the actor's org", async () => {
    const id = await installAtAnchor(WORKSPACE_ANCHOR);
    await archiveOp(platformAdmin);

    expect(await restoreOp(platformAdmin)).toBe(id);

    const after = await rawRowById(id);
    expect(after?.status).toBe("active");
    // The acting session HAS an active organization; the restored row must not
    // have acquired it.
    expect(after?.organization_id).toBeNull();
    expect(after?.owner_level).toBe("workspace");
    expect(await rawRows(PKG)).toHaveLength(1);
  });

  it("UPDATE rewrites the workspace row's version in place — same row, same anchor", async () => {
    const id = await installAtAnchor(WORKSPACE_ANCHOR, { version: "1.0.0" });
    const before = anchorOf(await rawRowById(id));

    expect(await updateOp(platformAdmin, "2.0.0")).toBe(id);

    const rows = await rawRows(PKG);
    // The defect this closes would have FORKED a second, org-anchored row.
    expect(rows).toHaveLength(1);
    const after = await rawRowById(id);
    expect(anchorOf(after)).toEqual(before);
    const stored = await canonicalStore.readInstalledExtensionsByPackageName(PKG);
    expect((stored[0]!.source as { version?: string }).version).toBe("2.0.0");
  });

  it("REINSTALL recreates the row AT THE PRIOR ANCHOR after the uninstall leg", async () => {
    await installAtAnchor(WORKSPACE_ANCHOR, { version: "1.0.0" });

    const newId = await reinstallOp(platformAdmin, "2.0.0");

    const rows = await rawRows(PKG);
    expect(rows).toHaveLength(1);
    expect(anchorOf(rows[0]!)).toEqual({
      owner_level: "workspace",
      organization_id: null,
      owner_id: "__platform__",
    });
    expect(rows[0]!.id).toBe(newId);
    const stored = await canonicalStore.readInstalledExtensionsByPackageName(PKG);
    expect((stored[0]!.source as { version?: string }).version).toBe("2.0.0");
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2698 — an org-anchored row behaves exactly as today", () => {
  it("ARCHIVE / RESTORE keep the org anchor and the org actor's own standing", async () => {
    const id = await installAtAnchor(ORG_ANCHOR);
    const before = anchorOf(await rawRowById(id));

    expect(await archiveOp(orgOwner)).toBe(id);
    expect((await rawRowById(id))?.status).toBe("archived");
    expect(await restoreOp(orgOwner)).toBe(id);

    const after = await rawRowById(id);
    expect(after?.status).toBe("active");
    expect(anchorOf(after)).toEqual(before);
    expect(anchorOf(after)).toEqual({
      owner_level: "organization",
      organization_id: ORG,
      owner_id: ORG,
    });
  });

  it("UPDATE / REINSTALL keep the org anchor", async () => {
    const id = await installAtAnchor(ORG_ANCHOR, { version: "1.0.0" });
    expect(await updateOp(orgOwner, "1.1.0")).toBe(id);
    expect(anchorOf(await rawRowById(id))).toEqual({
      owner_level: "organization",
      organization_id: ORG,
      owner_id: ORG,
    });

    await reinstallOp(orgOwner, "1.2.0");
    const rows = await rawRows(PKG);
    expect(rows).toHaveLength(1);
    expect(anchorOf(rows[0]!)).toEqual({
      owner_level: "organization",
      organization_id: ORG,
      owner_id: ORG,
    });
  });

  it("an org actor is REFUSED the workspace row — it serves every organization", async () => {
    await installAtAnchor(WORKSPACE_ANCHOR);
    await expect(archiveOp(orgOwner)).rejects.toMatchObject({
      code: "NO_ADDRESSABLE_ROW",
    });
    // Nothing moved.
    const rows = await rawRows(PKG);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// THE EFFECTIVE ROW + SUPERSESSION (cinatra#2698 rework, owner ruling
// 2026-08-16). This block replaces the earlier "coexisting rows: each op hits
// exactly the selected row" fixtures: coexistence is no longer a state the
// product presents, so an operator picking between two rows is no longer a
// behaviour to pin. What is pinned instead is that a live workspace row
// SUPERSEDES the organization rows, that the supersession is an in-place
// archive which retains everything, that a reverse install is refused, and that
// removing the workspace install revives nothing.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2698 — a live workspace row is the package's effective row", () => {
  it("a platform admin with an active organization resolves the WORKSPACE row — no selector", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR);
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR);
    const orgBefore = await rawRowById(orgRowId);

    // Before this rework the platform admin's OWN scope (their organization's
    // row) won and reaching the app-wide row required naming a tier. The
    // organization row is superseded now, so the workspace row resolves alone.
    expect(await archiveOp(platformAdmin)).toBe(wsId);

    expect((await rawRowById(wsId))?.status).toBe("archived");
    expect(await rawRowById(orgRowId)).toEqual(orgBefore);
  });

  it("an organization owner is refused — their own row is superseded", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR);
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR);
    const orgBefore = await rawRowById(orgRowId);
    const wsBefore = await rawRowById(wsId);

    await expect(archiveOp(orgOwner)).rejects.toMatchObject({
      code: "NO_ADDRESSABLE_ROW",
    });

    // Nothing moved — the refusal is fail-closed, not a partial op.
    expect(await rawRowById(orgRowId)).toEqual(orgBefore);
    expect(await rawRowById(wsId)).toEqual(wsBefore);
  });

  it("an ARCHIVED organization row is never a candidate either", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR);
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR);
    await lifecycle.transitionExtensionLifecycle(orgRowId, "archive", {
      actor: { source: "dispatcher", userId: "u-2698" },
      reason: "cinatra#2698 fixture — superseded",
    });

    // The org owner cannot restore the superseded row while the workspace row
    // lives — the reverse install, refused at the addressing rule.
    await expect(restoreOp(orgOwner)).rejects.toMatchObject({
      code: "NO_ADDRESSABLE_ROW",
    });
    // And the platform admin still lands on the workspace row, not the archived
    // organization one.
    expect(await archiveOp(platformAdmin)).toBe(wsId);
  });

  it("the selector still separates a WORKSPACE row from a bundled PLATFORM anchor", async () => {
    // The one genuine same-scope identity ambiguity the store permits: the
    // org-NULL identity index keys on owner_level. This is what the selector
    // machinery survives FOR — it is server-minted, never operator-supplied.
    const bundledId = await installAtAnchor(PLATFORM_ANCHOR);
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR);
    const nullOrgAdmin = { ...platformAdmin, orgId: null } as Actor;

    await expect(archiveOp(nullOrgAdmin)).rejects.toMatchObject({
      code: "AMBIGUOUS_LIFECYCLE_TARGET",
    });

    const bundledBefore = await rawRowById(bundledId);
    expect(await archiveOp(nullOrgAdmin, { ownerLevel: "workspace" })).toBe(wsId);
    expect((await rawRowById(wsId))?.status).toBe("archived");
    expect(await rawRowById(bundledId)).toEqual(bundledBefore);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2698 — supersession on install archives IN PLACE", () => {
  it("archives the organization row keeping id, anchor, provenance and dependency edges", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR, { version: "1.4.2" });
    // Row-bound data the ordinary uninstall path would destroy: an access-policy
    // row and a permission grant, BOTH keyed on installed_extension.id, plus the
    // dependency edge rows the hard delete cascades away.
    await lifecycle.recordExtensionDependencies(
      orgRowId,
      [
        {
          packageName: "@cinatra-ai/dep-2698",
          edgeType: "runtime",
          requirement: "required",
          versionConstraint: { kind: "semver-range", range: "^1.0.0" },
        },
      ] as never,
      { actor: { source: "dispatcher", userId: "u-2698" }, reason: "cinatra#2698 fixture" },
    );
    await client.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."extension_access_policy" (resource_kind, resource_id, policy)
       VALUES ($1, $2, $3::jsonb)`,
      ["artifact", orgRowId, JSON.stringify({ runListVisibility: ["organization"] })],
    );
    const before = await rawRowById(orgRowId);
    const edgesBefore = (
      await client.query(
        `SELECT * FROM "${q(TEST_SCHEMA)}"."extension_dependency_edge" WHERE dependent_install_id = $1 ORDER BY id`,
        [orgRowId],
      )
    ).rows;
    expect(edgesBefore.length).toBeGreaterThan(0);

    // The workspace install lands, then supersedes.
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR, { version: "2.0.0" });
    const archived = await lifecycle.supersedeOrganizationRowsForWorkspaceInstall(PKG, {
      source: "dispatcher",
      userId: "u-2698",
    });
    expect(archived).toEqual([orgRowId]);

    const after = await rawRowById(orgRowId);
    // SAME ROW: only `status` moved. Everything else is byte-identical, which is
    // what "archived in place, nothing torn down" means at the DB layer.
    expect(after?.id).toBe(orgRowId);
    expect(after?.status).toBe("archived");
    for (const column of Object.keys(before ?? {})) {
      if (column === "status" || column === "updated_at") continue;
      expect({ [column]: after?.[column] }).toEqual({ [column]: before?.[column] });
    }
    // Dependency provenance retained (a hard delete would have cascaded it away).
    const edgesAfter = (
      await client.query(
        `SELECT * FROM "${q(TEST_SCHEMA)}"."extension_dependency_edge" WHERE dependent_install_id = $1 ORDER BY id`,
        [orgRowId],
      )
    ).rows;
    expect(edgesAfter).toEqual(edgesBefore);
    // Access policy retained (it is keyed on the row id the archive preserved).
    const policyAfter = (
      await client.query(
        `SELECT policy FROM "${q(TEST_SCHEMA)}"."extension_access_policy" WHERE resource_id = $1`,
        [orgRowId],
      )
    ).rows;
    expect(policyAfter).toHaveLength(1);
    // And the workspace row is untouched and live.
    expect((await rawRowById(wsId))?.status).toBe("active");
  });

  it("is idempotent — an already-archived organization row is left exactly as it is", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR);
    await lifecycle.transitionExtensionLifecycle(orgRowId, "archive", {
      actor: { source: "dispatcher", userId: "u-2698" },
      reason: "cinatra#2698 fixture",
    });
    const before = await rawRowById(orgRowId);
    await installAtAnchor(WORKSPACE_ANCHOR);

    const archived = await lifecycle.supersedeOrganizationRowsForWorkspaceInstall(PKG, {
      source: "dispatcher",
      userId: "u-2698",
    });

    expect(archived).toEqual([]);
    expect(await rawRowById(orgRowId)).toEqual(before);
  });

  it("no organization rows → nothing happens", async () => {
    await installAtAnchor(WORKSPACE_ANCHOR);
    expect(
      await lifecycle.supersedeOrganizationRowsForWorkspaceInstall(PKG, {
        source: "dispatcher",
        userId: "u-2698",
      }),
    ).toEqual([]);
    expect(await rawRows(PKG)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2698 — reverse installs are refused", () => {
  it("the install boundary refuses an ORGANIZATION anchor while a live workspace row exists", async () => {
    await installAtAnchor(WORKSPACE_ANCHOR);
    const rows = await canonicalStore.readInstalledExtensionsByPackageName(PKG);

    expect(() => resolver.assertNoWorkspaceSupersession(PKG, rows, ORG_ANCHOR)).toThrow(
      /already installed for the whole workspace/,
    );
    try {
      resolver.assertNoWorkspaceSupersession(PKG, rows, ORG_ANCHOR);
    } catch (err) {
      expect((err as { code?: string }).code).toBe("WORKSPACE_INSTALL_SUPERSEDES");
    }
    // The workspace install itself passes through untouched.
    expect(() =>
      resolver.assertNoWorkspaceSupersession(PKG, rows, WORKSPACE_ANCHOR),
    ).not.toThrow();
  });

  it("an ARCHIVED workspace row supersedes nothing — the organization install is allowed again", async () => {
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR);
    await lifecycle.transitionExtensionLifecycle(wsId, "archive", {
      actor: { source: "dispatcher", userId: "u-2698" },
      reason: "cinatra#2698 fixture",
    });
    const rows = await canonicalStore.readInstalledExtensionsByPackageName(PKG);
    expect(() => resolver.assertNoWorkspaceSupersession(PKG, rows, ORG_ANCHOR)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!HAS_DB)("cinatra#2698 — removing the workspace install revives nothing", () => {
  it("the organization row stays archived, and only THEN becomes restorable", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR);
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR);
    await lifecycle.supersedeOrganizationRowsForWorkspaceInstall(PKG, {
      source: "dispatcher",
      userId: "u-2698",
    });
    expect((await rawRowById(orgRowId))?.status).toBe("archived");

    // Remove the workspace install — a row-scoped archive, exactly as the
    // dispatcher performs it.
    expect(await archiveOp(platformAdmin)).toBe(wsId);

    // NO AUTOMATIC REVIVAL: the organization row is still archived.
    expect((await rawRowById(orgRowId))?.status).toBe("archived");

    // It is now addressable again, so an authorized admin restores it through
    // the ORDINARY guarded path — nothing special, no supersession bookkeeping.
    expect(await restoreOp(orgOwner)).toBe(orgRowId);
    expect((await rawRowById(orgRowId))?.status).toBe("active");
    // And the workspace row stayed archived — the restore touched one row.
    expect((await rawRowById(wsId))?.status).toBe("archived");
  });
});
