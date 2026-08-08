/**
 * cinatra#2536 — THE BLOG-PIPELINE SCENARIO, proven end-to-end at the STORE
 * level against a REAL Postgres.
 *
 * THE DOCUMENTED STATE (from the issue's own instance): the blog packages were
 * LOADED at boot and runnable, while
 *
 *   SELECT count(*) FROM cinatra.installed_extension
 *    WHERE package_name IN ('@cinatra-ai/blog-post-artifact',
 *                           '@cinatra-ai/blog-draft-writer-agent');   -- 0
 *   SELECT count(*) FROM cinatra.artifact_type_claims;                -- 0
 *
 * …so every run of `blog-draft-writer-agent` failed materialization with
 * `extension "@cinatra-ai/blog-post-artifact" declares no artifact-safe object
 * type` — although that package's manifest DOES declare
 * `@cinatra-ai/blog-post-artifact:post` as an artifact-safe `dedicated` claim.
 * A plain restart re-hit the importer's "already up to date" skip, so it never
 * self-healed.
 *
 * WHY THIS CANNOT BE A MOCK TEST. The claim is about ROWS: that a boot pass
 * against a database in exactly that state ends with a live
 * `installed_extension` row AND an active `artifact_type_claims` row, that the
 * materializer's own resolution seam then resolves the binding, and that a
 * SECOND pass changes nothing. So it drives the REAL leaves:
 *   * the REAL manifest on disk — `extensions/cinatra-ai/blog-post-artifact`
 *     (nothing about the package is synthesized here);
 *   * the REAL canonical lifecycle primitive (`installExtensionManifest`);
 *   * the REAL claim registry DDL, incl. the partial-unique one-live-claimant
 *     indexes that a non-idempotent second activation would violate;
 *   * the REAL claim-activation hook (`runInstallAnchorClaimBackstop`);
 *   * the REAL materializer resolution seam (`resolveBoundArtifactTarget` →
 *     `readEffectiveArtifactSafeTypeIdsForExtension`, org-chain winner
 *     arbitration ∩ the registered host type).
 *
 * It is INSTANCE-LEVEL by construction: nothing here installs the producer
 * agent or repairs the catalog's missing `produces`→dependency edge (that is
 * the sibling cinatra#2537), so the heal is proven to stand alone.
 *
 * CI runs this in the `extension-lifecycle-db-tests` job (Postgres service
 * container). Locally: point SUPABASE_DB_URL at a Postgres and run with
 * CINATRA_DB_INTEGRATION_TESTS=1.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { Client } from "pg";

// The full app bootstrap references Supabase-only tables (public.user) absent
// on a plain verify Postgres; no-op it and build only the leaves this slice
// needs (same pattern as artifact-claim-install-anchor.integration.test.ts).
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL;
const PKG_DIR = path.join(process.cwd(), "extensions", "cinatra-ai", "blog-post-artifact");
const HAS_DB =
  typeof DB_URL === "string" &&
  DB_URL.length > 0 &&
  !DB_URL.includes("unused:unused@localhost:5432/unused") &&
  !DB_URL.includes("build:build@127.0.0.1:5432/build");
// The in-tree extension tree is cloned back by scripts/ci/sync-dev-extensions.mjs;
// without it there is no real manifest to prove anything about.
const HAS_PKG = existsSync(path.join(PKG_DIR, "package.json"));
const RUN = HAS_DB && HAS_PKG;

const TEST_SCHEMA = `cinatra_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const q = (s: string) => s.replaceAll('"', '""');

const EXT = "@cinatra-ai/blog-post-artifact";
const TYPE = "@cinatra-ai/blog-post-artifact:post";
const ORG = `org-${randomUUID().slice(0, 8)}`;

let client: Client;
let heal: typeof import("@/lib/extension-install-anchor");
let resolver: typeof import("@/lib/artifacts/resolve-bound-artifact-type");

async function installRows(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await client.query(
    `SELECT id, package_name, kind, status, owner_level, organization_id, version, source
       FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE package_name = $1`,
    [EXT],
  );
  return rows;
}

async function claimRows(): Promise<Array<Record<string, unknown>>> {
  const { rows } = await client.query(
    `SELECT id, scope, object_type_id, claim_kind, status, extension_package, extension_version
       FROM "${q(TEST_SCHEMA)}"."artifact_type_claims" WHERE extension_package = $1`,
    [EXT],
  );
  return rows;
}

beforeAll(async () => {
  if (!RUN) return;
  // MUST precede every store import: the canonical store, the claim store and
  // postgres-config all bind their schema at module load from this env var.
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);

  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  const { semanticAssertionSchemaQueries } = await import("@/lib/semantic-assertion-schema");
  const { artifactClaimSchemaQueries } = await import("@/lib/artifact-claim-schema");
  const ddl = [
    ...buildCreateStoreSchemaQueries(TEST_SCHEMA),
    ...semanticAssertionSchemaQueries(TEST_SCHEMA),
    ...artifactClaimSchemaQueries(TEST_SCHEMA),
  ];
  for (const qy of ddl) {
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

  heal = await import("@/lib/extension-install-anchor");
  resolver = await import("@/lib/artifacts/resolve-bound-artifact-type");

  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 180_000);

afterAll(async () => {
  if (!RUN) return;
  await client?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!RUN)("cinatra#2536 — boot-import heals the blog pipeline's absent install record", () => {
  it("reproduces the documented state: package on disk, ZERO install rows, ZERO claims, materialization refused", async () => {
    expect(await installRows()).toHaveLength(0);
    expect(await claimRows()).toHaveLength(0);

    const before = await resolver.resolveBoundArtifactTarget({ orgId: ORG, extension: EXT });

    expect(before.ok).toBe(false);
    // The corrected copy: the CAUSE (no install record) and the HEAL, never the
    // old manifest-blaming advice.
    expect(before.ok === false && before.error).toContain("no installed_extension row exists");
    expect(before.ok === false && before.error).toContain("The extension manifest is not at fault");
    expect(before.ok === false && before.error).not.toContain("declares no artifact-safe object type");
    // …and it names the very type the manifest declares.
    expect(before.ok === false && before.error).toContain(TYPE);
  });

  it("the heal seeds the install record AND the artifact-type claim, so the binding resolves", async () => {
    const outcome = await heal.healArtifactInstallRecordAndClaims({
      packageName: EXT,
      packageDir: PKG_DIR,
      version: "0.1.4",
    });

    expect(outcome.record.outcome).toBe("repaired");
    expect(outcome.claims).toBe("converged");

    // 1. Exactly ONE live, platform-scoped, artifact-kind row at the manifest
    //    version, carrying local (in-tree) provenance.
    const rows = await installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      package_name: EXT,
      kind: "artifact",
      status: "active",
      owner_level: "platform",
      organization_id: null,
      version: "0.1.4",
    });
    expect((rows[0]!.source as { type?: string }).type).toBe("local");

    // 2. The claim the whole chain hangs on — ACTIVE, at platform scope so
    //    every org's chain sees it.
    const claims = await claimRows();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      scope: "platform",
      object_type_id: TYPE,
      claim_kind: "dedicated",
      status: "active",
    });

    // 3. The materializer's own eligibility read (org-chain winner arbitration
    //    ∩ registered host type) now yields the declared type.
    expect(resolver.readEffectiveArtifactSafeTypeIdsForExtension(ORG, EXT)).toEqual([TYPE]);

    // 4. …and the binding the blog producer emits resolves end-to-end.
    const after = await resolver.resolveBoundArtifactTarget({ orgId: ORG, extension: EXT });
    expect(after).toEqual({
      ok: true,
      target: { objectTypeId: TYPE, acceptedFileMimeTypes: ["text/markdown"] },
    });
  });

  it("IDEMPOTENT: a second boot pass writes nothing — no duplicate row, no second claim generation", async () => {
    const rowsBefore = await installRows();
    const claimsBefore = await claimRows();

    const again = await heal.healArtifactInstallRecordAndClaims({
      packageName: EXT,
      packageDir: PKG_DIR,
      version: "0.1.4",
    });

    expect(again.record.outcome).toBe("already-live");
    expect(again.claims).toBe("converged");
    // Byte-identical: the one-live-claimant partial-unique indexes would reject
    // a naive re-activation, and a re-seeded row would duplicate the identity.
    expect(await installRows()).toEqual(rowsBefore);
    expect(await claimRows()).toEqual(claimsBefore);

    const after = await resolver.resolveBoundArtifactTarget({ orgId: ORG, extension: EXT });
    expect(after.ok).toBe(true);
  });

  it("CONCURRENT boot passes hit the REAL identity index: the loser resolves already-live, one row survives", async () => {
    // DETERMINISTIC, not hopeful (codex round 2): a plain Promise.all can let
    // the first insert land before the second even reads, which would never
    // exercise the unique-index loser path. A two-party barrier around the REAL
    // canonical read holds BOTH passes until both have seen zero rows, so both
    // go on to insert and exactly one must lose to Postgres.
    // Route the teardown through the canonical primitive, never raw SQL — the
    // canonical-gate-reach guard confines `installed_extension` writes to the
    // store, and this test must respect the same invariant it exercises.
    const primitive = await import("@cinatra-ai/extensions/lifecycle-primitive");
    for (const row of await installRows()) {
      await primitive.transitionExtensionLifecycle(row.id as string, "force_delete", {
        actor: { source: "worker" },
        reason: "integration fixture reset",
      });
    }
    expect(await installRows()).toHaveLength(0);

    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrieredRead = async (packageName: string) => {
      const rows = await heal.readInstallRecordRows(packageName); // the REAL read
      if (++arrived >= 2) release();
      await bothRead;
      return rows;
    };

    const outcomes = await Promise.all([
      heal.healMissingInstallRecord(
        { packageName: EXT, kind: "artifact", packageDir: PKG_DIR, version: "0.1.4" },
        { readRows: barrieredRead },
      ),
      heal.healMissingInstallRecord(
        { packageName: EXT, kind: "artifact", packageDir: PKG_DIR, version: "0.1.4" },
        { readRows: barrieredRead },
      ),
    ]);

    // Exactly one row, and NEITHER pass reports a failure: the loser re-probed
    // and resolved to the winner's row.
    expect(await installRows()).toHaveLength(1);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(["already-live", "repaired"]);
    expect(outcomes.every((o) => heal.healLeftRecordLive(o))).toBe(true);
  });

  it("the AGENT half of the boot importer's default wiring seeds its own record", async () => {
    // `ensureAgentPackageFromGitFile`'s `defaultHealInstallRecord` makes exactly
    // this call — `{ packageName, kind: "agent", packageDir, version }`. The
    // packages/agents suite pins the OTHER half at the module boundary: with NO
    // injected seam, the loader really resolves `@/lib/extension-install-record-
    // heal` and calls `healMissingInstallRecord` with those arguments. Together
    // the two leave no hop mocked on both sides.
    const AGENT = "@cinatra-ai/blog-draft-writer-agent";
    const agentDir = path.join(process.cwd(), "extensions", "cinatra-ai", "blog-draft-writer-agent");
    if (!existsSync(path.join(agentDir, "package.json"))) return; // lock-pinned tree absent

    const first = await heal.healMissingInstallRecord({
      packageName: AGENT,
      kind: "agent",
      packageDir: agentDir,
    });
    expect(first.outcome).toBe("repaired");

    const { rows } = await client.query(
      `SELECT kind, status, owner_level, organization_id FROM "${q(TEST_SCHEMA)}"."installed_extension"
        WHERE package_name = $1`,
      [AGENT],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "agent",
      status: "active",
      owner_level: "platform",
      organization_id: null,
    });

    const second = await heal.healMissingInstallRecord({
      packageName: AGENT,
      kind: "agent",
      packageDir: agentDir,
    });
    expect(second.outcome).toBe("already-live");
  });

  it("an ORG-SCOPED-ONLY install is never broadened into an instance-wide anchor", async () => {
    const SCOPED = "@cinatra-ai/blog-idea-artifact";
    const scopedDir = path.join(process.cwd(), "extensions", "cinatra-ai", "blog-idea-artifact");
    if (!existsSync(path.join(scopedDir, "package.json"))) return; // lock-pinned tree absent

    // One org installed it; no platform anchor exists.
    const primitive = await import("@cinatra-ai/extensions/lifecycle-primitive");
    await primitive.installExtensionManifest(
      {
        id: `iext_${randomUUID().slice(0, 12)}`,
        packageName: SCOPED,
        ownerLevel: "organization",
        ownerId: ORG,
        organizationId: ORG,
        kind: "artifact",
        source: { type: "local", path: scopedDir, resolvedCommitOrTreeHash: "fixture" },
        requiredInProd: false,
        dependencies: [],
        manifestHash: null,
      },
      { actor: { source: "worker" }, reason: "integration fixture" },
    );

    const outcome = await heal.healArtifactInstallRecordAndClaims({
      packageName: SCOPED,
      packageDir: scopedDir,
    });

    expect(outcome.record.outcome).toBe("refused-org-scoped");
    expect(outcome.claims).toBe("skipped");
    const { rows } = await client.query(
      `SELECT owner_level FROM "${q(TEST_SCHEMA)}"."installed_extension" WHERE package_name = $1`,
      [SCOPED],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.owner_level).toBe("organization");
  });

  it("an ARCHIVED install record is never resurrected by a later boot pass", async () => {
    const [row] = await installRows();
    // The archive goes through the REAL lifecycle primitive — both because the
    // canonical-gate-reach guard forbids raw writes and because an operator's
    // archive is exactly what this case must reproduce.
    const primitive = await import("@cinatra-ai/extensions/lifecycle-primitive");
    await primitive.transitionExtensionLifecycle(row!.id as string, "archive", {
      actor: { source: "worker" },
      reason: "integration fixture — operator archive",
    });

    const outcome = await heal.healArtifactInstallRecordAndClaims({
      packageName: EXT,
      packageDir: PKG_DIR,
      version: "0.1.4",
    });

    expect(outcome.record.outcome).toBe("refused-archived");
    expect(outcome.claims).toBe("skipped");
    const rows = await installRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("archived");
  });
});
