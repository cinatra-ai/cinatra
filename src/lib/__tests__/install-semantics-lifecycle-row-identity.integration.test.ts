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
 *   - with an org row and a workspace row COEXISTING for one package, each
 *     operation targets exactly the selected row and leaves the other untouched;
 *   - the operator's row selector — `owner_level`, the identity's discriminator
 *     — separates a product-installed workspace row from a bundled platform
 *     anchor at the same org-NULL scope.
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

const TEST_SCHEMA = "cinatra_test_install_semantics_2698";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
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
describe.skipIf(!HAS_DB)("cinatra#2698 — coexisting rows: each op hits exactly the selected row", () => {
  it("ARCHIVE of the org row leaves the workspace row byte-identical", async () => {
    const orgId = await installAtAnchor(ORG_ANCHOR);
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR);
    const wsBefore = await rawRowById(wsId);

    // The org actor's OWN scope wins with no selector at all.
    expect(await archiveOp(orgOwner)).toBe(orgId);

    expect((await rawRowById(orgId))?.status).toBe("archived");
    expect(await rawRowById(wsId)).toEqual(wsBefore);
  });

  it("ARCHIVE of the workspace row leaves the org row byte-identical", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR);
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR);
    const orgBefore = await rawRowById(orgRowId);

    // A platform admin in the SAME org must name the tier — their own scope has
    // a row, so the selector is what reaches across to the app-wide one.
    expect(await archiveOp(platformAdmin, { ownerLevel: "workspace" })).toBe(wsId);

    expect((await rawRowById(wsId))?.status).toBe("archived");
    expect(await rawRowById(orgRowId)).toEqual(orgBefore);
  });

  it("UPDATE of the workspace row leaves the org row byte-identical", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR, { version: "1.0.0" });
    const wsId = await installAtAnchor(WORKSPACE_ANCHOR, { version: "1.0.0" });
    const orgBefore = await rawRowById(orgRowId);

    expect(await updateOp(platformAdmin, "3.0.0", { ownerLevel: "workspace" })).toBe(wsId);

    expect(await rawRowById(orgRowId)).toEqual(orgBefore);
    expect(await rawRows(PKG)).toHaveLength(2);
    const stored = await canonicalStore.readInstalledExtensionsByPackageName(PKG);
    const ws = stored.find((r) => r.id === wsId)!;
    expect((ws.source as { version?: string }).version).toBe("3.0.0");
  });

  it("REINSTALL of the workspace row leaves the org row byte-identical", async () => {
    const orgRowId = await installAtAnchor(ORG_ANCHOR, { version: "1.0.0" });
    await installAtAnchor(WORKSPACE_ANCHOR, { version: "1.0.0" });
    const orgBefore = await rawRowById(orgRowId);

    await reinstallOp(platformAdmin, "3.0.0", { ownerLevel: "workspace" });

    expect(await rawRowById(orgRowId)).toEqual(orgBefore);
    const rows = await rawRows(PKG);
    expect(rows).toHaveLength(2);
    const ws = rows.find((r) => r.owner_level === "workspace")!;
    expect(ws.organization_id).toBeNull();
    expect(ws.owner_id).toBe("__platform__");
  });

  it("the selector separates a WORKSPACE row from a bundled PLATFORM anchor at the same scope", async () => {
    // The DB permits this coexistence: the org-NULL identity index keys on
    // owner_level. Without a selector the resolver refuses; with one it hits
    // exactly the named tier.
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
