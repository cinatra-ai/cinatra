/**
 * THE DB-LAYER PROOF of the install-semantics write path (cinatra#2694 /
 * S2 #2696) — the tuple the write path resolves, persisted through the REAL
 * canonical store + lifecycle primitive against a REAL Postgres, and read back.
 *
 * The unit suites pin each hop of the threading (action → batch → registry /
 * dispatcher). This suite answers the question those cannot: does the resolved
 * tuple actually LAND as a row, is it admitted by the platform invariant, does
 * it read back by identity, does it coexist with an organization-anchored row
 * for the same package without touching it, and does the rollback remove
 * exactly the row it created?
 *
 * Asserted here (S2's acceptance, at the DB layer):
 *   - "Workspace: All" → a row with the EXACT tuple (owner_level='workspace',
 *     organization_id NULL, owner_id='__platform__') carrying the ["workspace"]
 *     audience policy; "Workspace: Admins only" identically with ["admin"];
 *   - an ORGANIZATION-target install is byte-identical to the tuple today's
 *     actor-derived derivation produces (regression);
 *   - NO EXISTING ROW IS MODIFIED: a pre-existing org row is byte-identical
 *     before and after the workspace-anchored install;
 *   - rollback of a fresh workspace-anchored install leaves no row behind,
 *     while a pre-existing live row survives.
 *
 * KIND NOTE (epic sequencing, not a gap): the fixtures use the ARTIFACT kind.
 * The lifecycle primitive still REFUSES a non-bundled workspace-anchored
 * CONNECTOR (`connector install must be organization-anchored …`) — relaxing
 * that is S3 (#2697), explicitly. The refusal is asserted here so S3 inherits a
 * live pin rather than a claim.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL=postgres://postgres:postgres@127.0.0.1:5634/postgres \
 *     pnpm test src/lib/__tests__/install-semantics-write-path.integration
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const TEST_SCHEMA = "cinatra_test_install_semantics_2696";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

const ORG = "org-2696-a";
const OTHER_ORG = "org-2696-b";
const PKG = "@cinatra-ai/ws-artifact-2696";

let canonicalStore: typeof import("@cinatra-ai/extensions/canonical-store");
let lifecycle: typeof import("@cinatra-ai/extensions/lifecycle-primitive");
let anchors: typeof import("@cinatra-ai/extensions/install-row-anchor");
let contract: typeof import("@cinatra-ai/extensions/install-access-target");
let client: Client;

type RawRow = Record<string, unknown>;

async function rawRows(packageName: string): Promise<RawRow[]> {
  const res = await client.query(
    `SELECT * FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE package_name = $1 ORDER BY id`,
    [packageName],
  );
  return res.rows as RawRow[];
}

function source(version = "1.0.0") {
  return {
    type: "verdaccio" as const,
    registryUrl: "http://localhost:4873",
    packageName: PKG,
    version,
    integrity: "sha512-real-2696",
  };
}

/** Install a canonical row AT THE ANCHOR the write path resolves — the real primitive. */
async function installAtAnchor(
  anchor: { ownerLevel: string; ownerId: string | null; organizationId: string | null },
  over: { packageName?: string; kind?: string; version?: string } = {},
): Promise<string> {
  const id = `iext_${randomUUID().slice(0, 12)}`;
  await lifecycle.installExtensionManifest(
    {
      id,
      packageName: over.packageName ?? PKG,
      ownerLevel: anchor.ownerLevel as never,
      ownerId: anchor.ownerId,
      organizationId: anchor.organizationId,
      kind: (over.kind ?? "artifact") as never,
      source: { ...source(over.version), packageName: over.packageName ?? PKG } as never,
      requiredInProd: false,
      dependencies: [],
      manifestHash: null,
      status: "active",
    } as never,
    { actor: { source: "dispatcher", userId: "u-2696" }, reason: "cinatra#2696 fixture" },
  );
  return id;
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
  anchors = await import("@cinatra-ai/extensions/install-row-anchor");
  contract = await import("@cinatra-ai/extensions/install-access-target");

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
  // store + DDL, and this fixture has no reason to be an exception).
  for (const pkg of [PKG, "@cinatra-ai/ws-connector-2696", "@cinatra-ai/org-connector-2696"]) {
    for (const row of await canonicalStore.readInstalledExtensionsByPackageName(pkg)) {
      await lifecycle.deleteScopedCanonicalRow(row.id);
    }
  }
});

describe.skipIf(!HAS_DB)("cinatra#2696 — the workspace anchor lands as a real row", () => {
  it('"Workspace: All" writes the EXACT workspace tuple and reads back by identity', async () => {
    // The tuple the write path resolves, end to end: the picker's target →
    // S1's contract → the dispatcher's anchor resolution.
    const { rowOwnership, policy } = contract.resolveInstallAccessTargetContract(
      { level: "workspace", id: ORG },
      ORG,
    );
    const anchor = anchors.resolveInstallRowAnchor(ORG, rowOwnership);

    const id = await installAtAnchor(anchor);

    // 1. The DB accepted it — the platform-invariant CHECK admits this shape.
    const raw = await rawRows(PKG);
    expect(raw).toHaveLength(1);
    expect({
      owner_level: raw[0]!.owner_level,
      organization_id: raw[0]!.organization_id,
      owner_id: raw[0]!.owner_id,
    }).toEqual({ owner_level: "workspace", organization_id: null, owner_id: "__platform__" });

    // 2. It reads back BY THE ANCHOR'S IDENTITY (the identity the install
    //    action's snapshot + the access write key on).
    const byIdentity = await canonicalStore.readInstalledExtensionByIdentity({
      organizationId: anchor.organizationId,
      ownerLevel: anchor.ownerLevel,
      ownerId: anchor.ownerId,
      packageName: PKG,
    });
    expect(byIdentity?.id).toBe(id);
    expect(byIdentity?.status).toBe("active");

    // 3. The audience policy the SAME contract call resolved.
    expect(policy).toEqual({
      runListVisibility: ["workspace"],
      runDataVisibility: ["workspace"],
      runExecuteVisibility: ["workspace"],
      allowRunSharing: false,
    });
  });

  it('"Workspace: Admins only" writes the SAME anchor with the ["admin"] audience', async () => {
    const { rowOwnership, policy } = contract.resolveInstallAccessTargetContract(
      { level: "admin", id: ORG },
      ORG,
    );
    const anchor = anchors.resolveInstallRowAnchor(ORG, rowOwnership);
    await installAtAnchor(anchor);

    const raw = await rawRows(PKG);
    expect({
      owner_level: raw[0]!.owner_level,
      organization_id: raw[0]!.organization_id,
      owner_id: raw[0]!.owner_id,
    }).toEqual({ owner_level: "workspace", organization_id: null, owner_id: "__platform__" });
    expect(policy).toEqual({
      runListVisibility: ["admin"],
      runDataVisibility: ["admin"],
      runExecuteVisibility: ["admin"],
      allowRunSharing: false,
    });
  });

  it("REGRESSION: an ORGANIZATION target writes the same tuple today's derivation produces", async () => {
    const { rowOwnership, policy } = contract.resolveInstallAccessTargetContract(
      { level: "organization", id: ORG },
      ORG,
    );
    const anchor = anchors.resolveInstallRowAnchor(ORG, rowOwnership);
    // Identical to the pre-#2696 actor-derived anchor.
    expect(anchor).toEqual(anchors.actorDerivedRowAnchor(ORG));
    // …and the organization target still defers to the kind's install default.
    expect(policy).toBeUndefined();

    await installAtAnchor(anchor);

    const raw = await rawRows(PKG);
    expect({
      owner_level: raw[0]!.owner_level,
      organization_id: raw[0]!.organization_id,
      owner_id: raw[0]!.owner_id,
    }).toEqual({ owner_level: "organization", organization_id: ORG, owner_id: ORG });
  });

  it("the workspace row is visible to EVERY organization's identity read (org-NULL anchor)", async () => {
    const anchor = anchors.resolveInstallRowAnchor(ORG, contract.WORKSPACE_ANCHOR_ROW_OWNERSHIP);
    const id = await installAtAnchor(anchor);

    // The row carries no owning org, so the SAME identity resolves it no matter
    // which organization the reader is acting in — that is what makes the
    // "Workspace: All" reach app-wide (the cross-org guard has nothing to fence).
    for (const readerOrg of [ORG, OTHER_ORG]) {
      const row = await canonicalStore.readInstalledExtensionByIdentity({
        organizationId: null,
        ownerLevel: "workspace",
        ownerId: "__platform__",
        packageName: PKG,
      });
      expect(row?.id, `resolved for a reader acting in ${readerOrg}`).toBe(id);
      // …and the row itself names no owning organization, so there is nothing
      // for the cross-org guard to fence it with.
      expect(row?.organizationId, readerOrg).toBeNull();
    }
  });
});

describe.skipIf(!HAS_DB)("cinatra#2696 — coexistence: no existing row is modified", () => {
  it("a workspace-anchored install leaves a pre-existing ORG row byte-identical", async () => {
    const orgAnchor = anchors.actorDerivedRowAnchor(ORG);
    const orgRowId = await installAtAnchor(orgAnchor, { version: "0.9.0" });
    const before = (await rawRows(PKG)).find((r) => r.id === orgRowId)!;

    // …now install the SAME package at the workspace anchor.
    const wsAnchor = anchors.resolveInstallRowAnchor(ORG, contract.WORKSPACE_ANCHOR_ROW_OWNERSHIP);
    const wsRowId = await installAtAnchor(wsAnchor);

    const after = await rawRows(PKG);
    expect(after).toHaveLength(2); // the org-NULL partial identity index keys them apart
    const orgAfter = after.find((r) => r.id === orgRowId)!;
    // BYTE-IDENTICAL — every column, updated_at included.
    expect(orgAfter).toEqual(before);
    expect(after.find((r) => r.id === wsRowId)!.organization_id).toBeNull();
  });

  it("both rows resolve independently by their own identity", async () => {
    const orgRowId = await installAtAnchor(anchors.actorDerivedRowAnchor(ORG));
    const wsRowId = await installAtAnchor(
      anchors.resolveInstallRowAnchor(ORG, contract.WORKSPACE_ANCHOR_ROW_OWNERSHIP),
    );

    const org = await canonicalStore.readInstalledExtensionByIdentity({
      organizationId: ORG,
      ownerLevel: "organization",
      ownerId: ORG,
      packageName: PKG,
    });
    const ws = await canonicalStore.readInstalledExtensionByIdentity({
      organizationId: null,
      ownerLevel: "workspace",
      ownerId: "__platform__",
      packageName: PKG,
    });
    expect(org?.id).toBe(orgRowId);
    expect(ws?.id).toBe(wsRowId);
  });
});

describe.skipIf(!HAS_DB)("cinatra#2696 — rollback of a workspace-anchored install", () => {
  it("deletes exactly the row it created and leaves NO row behind", async () => {
    const wsAnchor = anchors.resolveInstallRowAnchor(ORG, contract.WORKSPACE_ANCHOR_ROW_OWNERSHIP);
    const wsRowId = await installAtAnchor(wsAnchor);
    expect(await rawRows(PKG)).toHaveLength(1);

    // The row-scoped inverse — the SAME one the batch compensation uses, and
    // the one the install action's fail-closed rollback takes for an org-NULL
    // anchor (the org-pinned lifecycle resolver cannot address it; S4 #2698).
    await lifecycle.deleteScopedCanonicalRow(wsRowId);

    expect(await rawRows(PKG)).toHaveLength(0);
    expect(
      await canonicalStore.readInstalledExtensionByIdentity({
        organizationId: null,
        ownerLevel: "workspace",
        ownerId: "__platform__",
        packageName: PKG,
      }),
    ).toBeNull();
  });

  it("a PRE-EXISTING live row survives the rollback of the fresh workspace row", async () => {
    const orgRowId = await installAtAnchor(anchors.actorDerivedRowAnchor(ORG), { version: "0.9.0" });
    const before = (await rawRows(PKG)).find((r) => r.id === orgRowId)!;
    const wsRowId = await installAtAnchor(
      anchors.resolveInstallRowAnchor(ORG, contract.WORKSPACE_ANCHOR_ROW_OWNERSHIP),
    );

    await lifecycle.deleteScopedCanonicalRow(wsRowId);

    const after = await rawRows(PKG);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });
});

describe.skipIf(!HAS_DB)("cinatra#2696 — the connector substrate is still S3's (sequencing pin)", () => {
  it("a non-bundled WORKSPACE-anchored connector is still refused by the lifecycle primitive", async () => {
    const wsAnchor = anchors.resolveInstallRowAnchor(ORG, contract.WORKSPACE_ANCHOR_ROW_OWNERSHIP);
    await expect(
      installAtAnchor(wsAnchor, { packageName: "@cinatra-ai/ws-connector-2696", kind: "connector" }),
    ).rejects.toThrow(/connector install must be organization-anchored/);
    expect(await rawRows("@cinatra-ai/ws-connector-2696")).toHaveLength(0);
  });

  it("an ORGANIZATION-anchored connector install is unaffected", async () => {
    const id = await installAtAnchor(anchors.actorDerivedRowAnchor(ORG), {
      packageName: "@cinatra-ai/org-connector-2696",
      kind: "connector",
    });
    const raw = await rawRows("@cinatra-ai/org-connector-2696");
    expect(raw).toHaveLength(1);
    expect(raw[0]!.id).toBe(id);
  });
});
