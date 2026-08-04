/**
 * cinatra#2415 — THE COMPENSATION INVARIANT, proven against a REAL Postgres.
 *
 *   Compensation deletes ONLY the canonical `installed_extension` rows the
 *   failed batch created; every pre-existing row survives — the SAME package in
 *   the SAME org, and every OTHER org's row.
 *
 * WHY THIS CANNOT BE A MOCK TEST. The claim is about rows in Postgres: which
 * ones are gone and which ones are byte-identical afterwards. The defect it
 * pins (#2415) was a REFUSAL raised by the row-scoped lifecycle standing gate
 * against a role-less actor, and the boundary it must not cross (#2410) is the
 * PACKAGE-GLOBAL hard-delete branch that tears down other orgs' rows. Both live
 * in real store code, so the proof drives:
 *   * the REAL saga (`installExtensionWithDependencies`),
 *   * a REAL canonical insert per member (`installExtensionManifest`),
 *   * the REAL durable ledger (`extension_install_batches`, JSONB members) —
 *     so the batch provenance genuinely round-trips through Postgres,
 *   * the REAL row-scoped inverse (`uninstallMemberRowScoped` →
 *     `deleteScopedCanonicalRow`) taken straight from
 *     `makeDefaultInstallBatchSagaDeps()`.
 * Only the registry/network seams (packument resolution, gatekept authorize,
 * the agent-runtime reload) are injected — none of them touch a canonical row.
 *
 * ASSERTIONS ARE POSITIVE, NEVER LOG GREPS (AC3): every compensation call is
 * asserted to have SUCCEEDED (the saga's own per-member outcome lists), the
 * created row ids are asserted to no longer RESOLVE
 * (`readInstalledExtensionById` → null), and the unrelated row ids are asserted
 * to still resolve with a byte-identical raw DB snapshot.
 *
 * CI runs this in the `extension-lifecycle-db-tests` job (Postgres service
 * container). Locally: point SUPABASE_DB_URL at a Postgres and run with
 * CINATRA_DB_INTEGRATION_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import type { Actor } from "@cinatra-ai/extension-types";
import type { InstallBatchSagaDeps } from "@/lib/extension-install-batch";
import type { DependencyInstallPlan, PlannedMember } from "@/lib/extension-dependency-plan";

const DB_URL = process.env.SUPABASE_DB_URL;
const HAS_DB =
  typeof DB_URL === "string" &&
  DB_URL.length > 0 &&
  !DB_URL.includes("unused:unused@localhost:5432/unused") &&
  !DB_URL.includes("build:build@127.0.0.1:5432/build");

const TEST_SCHEMA = `cinatra_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const q = (s: string) => s.replaceAll('"', '""');

const ORG_A = `org-a-${randomUUID().slice(0, 8)}`;
const ORG_B = `org-b-${randomUUID().slice(0, 8)}`;

const ROOT = "@cinatra-ai/it-root";
const FRESH_DEP = "@cinatra-ai/it-fresh-dep";
/** Installed in ORG_A BEFORE the batch; also a planned member (same org). */
const SAME_ORG_PRE = "@cinatra-ai/it-same-org-pre";
/** Installed in ORG_A before the batch and NOT a member at all. */
const BYSTANDER = "@cinatra-ai/it-bystander";

type CanonicalStore = typeof import("@cinatra-ai/extensions/canonical-store");
type LifecyclePrimitive = typeof import("@cinatra-ai/extensions/lifecycle-primitive");
type BatchModule = typeof import("@/lib/extension-install-batch");
type BatchOps = typeof import("@/lib/extension-install-batch-ops");

let client: Client;
let store: CanonicalStore;
let primitive: LifecyclePrimitive;
let batchModule: BatchModule;
let batchOps: BatchOps;

/** Insert a canonical row through the REAL lifecycle primitive. */
async function seedRow(
  packageName: string,
  organizationId: string | null,
  version = "1.0.0",
): Promise<string> {
  const id = `iext_${randomUUID()}`;
  await primitive.installExtensionManifest(
    {
      id,
      packageName,
      kind: "artifact",
      ownerLevel: organizationId ? "organization" : "platform",
      ownerId: organizationId,
      organizationId,
      requiredInProd: false,
      manifestHash: null,
      dependencies: [],
      source: {
        type: "verdaccio",
        registryUrl: "https://registry.example",
        packageName,
        version,
        integrity: `sha512-${"a".repeat(20)}`,
        resolvedAt: new Date().toISOString(),
      },
    } as Parameters<LifecyclePrimitive["installExtensionManifest"]>[0],
    { actor: { source: "worker" }, reason: "integration fixture" },
  );
  return id;
}

/** The RAW DB row, for byte-identity snapshots of the survivors. */
async function rawRow(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query(
    `SELECT * FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  // MUST precede every store import: the canonical store binds its pgSchema at
  // module load from this env var.
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
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

  store = await import("@cinatra-ai/extensions/canonical-store");
  primitive = await import("@cinatra-ai/extensions/lifecycle-primitive");
  batchModule = await import("@/lib/extension-install-batch");
  batchOps = await import("@/lib/extension-install-batch-ops");

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

/**
 * REAL saga deps with only the registry/network/runtime seams injected. The
 * canonical-row seams — `listScopedRowIds`, `uninstallMemberRowScoped`,
 * `withPackageInstallLock` — and the durable ledger are the REAL ones.
 */
async function realDepsWithPlan(
  planned: PlannedMember[],
  failOn: string,
  orgId: string | null,
): Promise<InstallBatchSagaDeps> {
  const real = await batchModule.makeDefaultInstallBatchSagaDeps();
  return {
    ...real,
    isGatekeptInstallEnabled: () => false,
    getActiveGrantContext: () => null,
    withGlobalLifecycleLock: async (fn) => fn(),
    withSagaOwnedFanout: async (_root, fn) => fn(),
    triggerAgentRuntimeReload: async () => ({ ok: true as const }),
    // No declaration on disk for these synthetic packages; assert the decision
    // explicitly rather than depending on a filesystem miss.
    isMemberProtected: async () => false,
    plan: async (): Promise<DependencyInstallPlan> => ({
      ordered: planned,
      root: { packageName: ROOT, version: "1.0.0" },
      source: "manifest-walk",
      memberKinds: new Map(),
    }),
    // A REAL canonical insert per member. Models the store's own
    // (package, org) DEFAULT-row uniqueness: a member whose row already exists
    // at the scope is re-materialized in place, creating NO new row — which is
    // exactly the `createdRowIds: []` "provably created nothing" case.
    installMember: async (m) => {
      if (m.packageName === failOn) {
        throw new Error(`integration: member ${m.packageName} refused by its own pipeline`);
      }
      const existing = (await store.readInstalledExtensionsByPackageName(m.packageName)).filter(
        (r) => (r.organizationId ?? null) === orgId,
      );
      if (existing.length > 0) return;
      await seedRow(m.packageName, orgId, m.version);
    },
    updateMemberPackage: async () => {},
    installMemberSideBySide: async () => {},
    uninstallSideBySideMember: async () => {},
    readInstallOpForVersion: async () => null,
    readInstallOp: async () => null,
    readLiveRowVersion: async (packageName, scope) => {
      const live = (await store.readInstalledExtensionsByPackageName(packageName)).filter(
        (r) =>
          (r.status === "active" || r.status === "locked") &&
          (r.organizationId ?? null) === (scope ?? null),
      );
      return live.length > 0 ? { present: true, version: "1.0.0" } : { present: false };
    },
    ledger: {
      begin: (i) => batchOps.beginInstallBatch(i),
      setPhase: (id, phase) => batchOps.setInstallBatchPhase(id, phase),
      updateMember: (id, pkg, patch) => batchOps.updateInstallBatchMember(id, pkg, patch),
      listActive: () => batchOps.listActiveInstallBatches(),
    },
  };
}

function plannedMember(packageName: string, over: Partial<PlannedMember> = {}): PlannedMember {
  return {
    packageName,
    version: "1.0.0",
    typeId: "artifact",
    edges: [],
    alreadyInstalled: false,
    rowOwnership: { ownerLevel: "organization", ownerId: ORG_A, organizationId: ORG_A },
    action: "install",
    ...over,
  } as PlannedMember;
}

describe.skipIf(!HAS_DB)("cinatra#2415 — batch compensation scope (real Postgres)", () => {
  it(
    "an aborting batch leaves ZERO rows it created; the same-org and other-org pre-existing rows survive byte-unchanged",
    async () => {
      // ---- ARRANGE: rows that PRE-EXIST the batch -------------------------
      // (1) the SAME package the batch plans, in the SAME org as the batch;
      const sameOrgPreId = await seedRow(SAME_ORG_PRE, ORG_A);
      // (2) the SAME package the batch installs FRESH, in ANOTHER org — the
      //     #2410 boundary: a package-global hard-delete would destroy this;
      const otherOrgFreshDepId = await seedRow(FRESH_DEP, ORG_B);
      // (3) an unrelated package in the batch's own org.
      const bystanderId = await seedRow(BYSTANDER, ORG_A);

      const before = {
        sameOrgPre: await rawRow(sameOrgPreId),
        otherOrgFreshDep: await rawRow(otherOrgFreshDepId),
        bystander: await rawRow(bystanderId),
      };
      expect(before.sameOrgPre).not.toBeNull();
      expect(before.otherOrgFreshDep).not.toBeNull();
      expect(before.bystander).not.toBeNull();

      // ---- ACT: a batch whose ROOT fails after two members landed ---------
      const actor: Actor = {
        actorType: "human",
        source: "ui",
        userId: `u-${randomUUID().slice(0, 8)}`,
        orgId: ORG_A,
        // Deliberately platform-standing: the compensation actor must STRIP it
        // rather than ride it into the package-global hard-delete (#2410).
        platformRole: "platform_admin",
      };
      const deps = await realDepsWithPlan(
        [plannedMember(SAME_ORG_PRE), plannedMember(FRESH_DEP), plannedMember(ROOT)],
        ROOT,
        ORG_A,
      );

      let thrown: unknown;
      try {
        await batchModule.installExtensionWithDependencies(
          { packageName: ROOT, version: "1.0.0", actor },
          deps,
        );
        expect.unreachable("the batch must have aborted");
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(batchModule.BatchMemberInstallError);
      const failure = thrown as InstanceType<BatchModule["BatchMemberInstallError"]>;

      // ---- ASSERT 1: every compensation call SUCCEEDED (positive) ---------
      expect(failure.compensationFailures).toEqual([]);
      expect(failure.compensated).toContain(FRESH_DEP);

      // ---- ASSERT 2: the rows THIS batch created no longer RESOLVE --------
      const batches = await batchOps.listRecentInstallBatches({ limit: 5, orgId: ORG_A });
      const ledgerBatch = batches.find((b) => b.rootPackage === ROOT);
      expect(ledgerBatch).toBeDefined();
      const freshMember = ledgerBatch!.members.find((m) => m.packageName === FRESH_DEP)!;
      // The durable provenance round-tripped through Postgres JSONB.
      expect(freshMember.preRowIds).toEqual([]);
      expect(freshMember.createdRowIds).toHaveLength(1);
      const createdId = freshMember.createdRowIds![0]!;
      expect(await store.readInstalledExtensionById(createdId)).toBeNull();
      expect(await rawRow(createdId)).toBeNull();

      // The batch's own org holds NO row for the freshly-installed package.
      const freshDepRows = await store.readInstalledExtensionsByPackageName(FRESH_DEP);
      expect(freshDepRows.filter((r) => r.organizationId === ORG_A)).toEqual([]);

      // ---- ASSERT 3: the unrelated rows STILL resolve, byte-unchanged -----
      for (const id of [sameOrgPreId, otherOrgFreshDepId, bystanderId]) {
        expect(await store.readInstalledExtensionById(id)).not.toBeNull();
      }
      expect(await rawRow(sameOrgPreId)).toEqual(before.sameOrgPre);
      expect(await rawRow(otherOrgFreshDepId)).toEqual(before.otherOrgFreshDep);
      expect(await rawRow(bystanderId)).toEqual(before.bystander);

      // The same-org pre-existing member is recorded as PROVABLY created
      // nothing — it was skipped on evidence, not on a version guess.
      const preMember = ledgerBatch!.members.find((m) => m.packageName === SAME_ORG_PRE)!;
      expect(preMember.createdRowIds).toEqual([]);

      // The ledger closed cleanly (no ROLLBACK INCOMPLETE).
      expect(ledgerBatch!.phase).toBe("compensated");
      expect(failure.message).not.toContain("ROLLBACK INCOMPLETE");
    },
    120_000,
  );

  it(
    "a PLATFORM-scoped batch compensates its own NULL-org row and never an org row for the same package",
    async () => {
      const PLATFORM_PKG = "@cinatra-ai/it-platform-dep";
      // An org already installed this package; the platform batch must not
      // touch it (the package-global hard-delete would).
      const orgRowId = await seedRow(PLATFORM_PKG, ORG_B);
      const orgRowBefore = await rawRow(orgRowId);

      const actor: Actor = { actorType: "human", source: "ui", userId: "u-platform" };
      const deps = await realDepsWithPlan(
        [
          plannedMember(PLATFORM_PKG, {
            rowOwnership: { ownerLevel: "platform", ownerId: null, organizationId: null },
          }),
          plannedMember(ROOT, {
            rowOwnership: { ownerLevel: "platform", ownerId: null, organizationId: null },
          }),
        ],
        ROOT,
        null,
      );

      await expect(
        batchModule.installExtensionWithDependencies(
          { packageName: ROOT, version: "1.0.0", actor },
          deps,
        ),
      ).rejects.toBeInstanceOf(batchModule.BatchMemberInstallError);

      // The platform (NULL-org) row this batch created is gone…
      const rows = await store.readInstalledExtensionsByPackageName(PLATFORM_PKG);
      expect(rows.filter((r) => r.organizationId === null)).toEqual([]);
      // …and the OTHER org's row for the same package is byte-unchanged.
      expect(await store.readInstalledExtensionById(orgRowId)).not.toBeNull();
      expect(await rawRow(orgRowId)).toEqual(orgRowBefore);
    },
    120_000,
  );
});
