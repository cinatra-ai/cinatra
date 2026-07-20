/**
 * cinatra#926 — content-addressed artifact blob store, REAL-SURFACE
 * integration test (no mocks on the storage/DB path).
 *
 * Guarded by `describe.skipIf(!HAS_REAL_DB)` like
 * `agent-templates-schema.test.ts`: CI without a reachable Postgres emits
 * zero failures and zero noise. With a real `SUPABASE_DB_URL` it drives:
 *
 *   1. the drizzle-store DDL against a fresh per-test schema (including the
 *      new `artifact_blobs_org_storage_key_idx` reachability index);
 *   2. `createSemanticArtifact` end-to-end → org-scoped content-addressed
 *      file on the configured root + `artifact_blobs`/`resource` rows whose
 *      storage_key is the content key;
 *   3. same-bytes semantic dedupe → ONE resource, TWO artifacts, and the
 *      SHARED final file surviving the dedupe-loser cleanup;
 *   4. the reachability-guarded delete with its DEFAULT (real-DB) probe:
 *      an old-but-referenced file is kept; once the rows are gone it is
 *      removed;
 *   5. the verifier with its DEFAULT (real-DB) row lister: clean report,
 *      then a dangling-row report after the file is unlinked.
 *
 * Per the integration convention the schema is created fresh per test file
 * (never the worktree's shared schema); the artifact root is a temp dir via
 * `CINATRA_ARTIFACT_DATA_ROOT` — which also live-proves the configurable
 * root.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// The root vitest config aliases @/lib/database to a stub that lacks the
// named exports the artifact-creation graph imports. Mock EXACTLY the
// surface those modules touch: the classifier chat reader (only called when
// a chatContextSource is supplied — never here) and the metadata helpers
// (artifact-data-root falls back to them; the env var below wins anyway).
vi.mock("@/lib/database", () => ({
  readChatThreadForClassifier: () => null,
  readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
  writeMetadataValueToDatabase: () => {},
}));

const TEST_SCHEMA = "cinatra_test_artifact_blob_926";
// Fixture artifact type the REQUIRED-objectType writer validates against
// (epic #1785 wave A3).
const FIXTURE_OBJECT_TYPE = "@cinatra-ai/test-fixture-artifact:doc";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
// vitest.config.ts sets the placeholder `unused:unused@` URL when the host
// shell did not export a real value — skip on it (zero CI noise).
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

const ORG = "org-int-926";

async function* bytes(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!HAS_REAL_DB)("cinatra#926 content-addressed blob store (real DB + disk)", () => {
  let client: Client;
  let artifactRoot: string;
  let priorSchemaEnv: string | undefined;
  let priorRootEnv: string | undefined;

  beforeAll(async () => {
    priorSchemaEnv = process.env.SUPABASE_SCHEMA;
    priorRootEnv = process.env.CINATRA_ARTIFACT_DATA_ROOT;
    // MUST be set before the artifact modules are dynamically imported —
    // `postgresSchema` is a module-load const in postgres-config.
    process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
    artifactRoot = mkdtempSync(path.join(tmpdir(), "cin-926-int-"));
    process.env.CINATRA_ARTIFACT_DATA_ROOT = artifactRoot;

    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);

    // Provision the schema with the DDL subset (CREATE/ALTER/DROP), the
    // `_fixture.ts` / agent-templates-schema pattern; then mark the
    // process-wide ensure flag so `createSemanticArtifact`'s internal
    // `ensurePostgresSchema()` short-circuits instead of re-running the
    // full bootstrap (which includes seed writes).
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const q of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = q.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") {
        continue;
      }
      try {
        await client.query(q.text, (q as { values?: unknown[] }).values as never[]);
      } catch (err) {
        // Same tolerance as `_fixture.ts` `createTestSchema`: a handful of
        // statements reference seed/DO-block dependencies absent in a fresh
        // empty schema. The artifact tables this suite exercises
        // (artifact_blobs, resource, representation, objects,
        // semantic_assertion, artifact_audit) use plain types and never hit
        // this branch.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist")) throw err;
      }
    }
    (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

    // Register the fixture artifact type the writer requires (epic #1785 wave
    // A3: createSemanticArtifact validates a REQUIRED, installed, accepts-
    // matching objectType before any blob IO). A disk/fixture type with no
    // install row is ungoverned → write-eligible; its accepts admit text/plain.
    const { objectTypeRegistry } = await import("@cinatra-ai/objects/registry");
    const { z } = await import("zod");
    objectTypeRegistry.register({
      type: FIXTURE_OBJECT_TYPE,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/plain"] } } },
      dispositions: { projection: "artifact-safe" },
    });
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await client?.end().catch(() => {});
    rmSync(artifactRoot, { recursive: true, force: true });
    delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
    if (priorSchemaEnv === undefined) delete process.env.SUPABASE_SCHEMA;
    else process.env.SUPABASE_SCHEMA = priorSchemaEnv;
    if (priorRootEnv === undefined) delete process.env.CINATRA_ARTIFACT_DATA_ROOT;
    else process.env.CINATRA_ARTIFACT_DATA_ROOT = priorRootEnv;
  });

  const content = "cinatra#926 integration payload";
  const contentSha = sha(content);
  const expectedKey = `orgs/${ORG}/blobs/sha256/${contentSha.slice(0, 2)}/${contentSha}.bin`;
  let firstArtifactId = "";
  let firstResourceId = "";

  it("provisions artifact_blobs with the (org_id, storage_key) reachability index", async () => {
    const res = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'artifact_blobs'`,
      [TEST_SCHEMA],
    );
    const names = res.rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain("artifact_blobs_org_storage_key_idx");
  });

  it("createSemanticArtifact → content-addressed file + rows; storage-key read round-trips", async () => {
    const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");
    const res = await createSemanticArtifact({
      orgId: ORG,
      createdBy: null,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "926 integration one",
      objectType: FIXTURE_OBJECT_TYPE,
      declaredMime: "text/plain",
      originKind: "agent_generated",
      skipFallbackClassification: true, // no BullMQ in the integration sandbox
      stream: bytes(content),
    });
    firstArtifactId = res.artifactId;
    firstResourceId = res.resourceId;

    // Bytes on disk under the CONFIGURED root at the content-addressed key.
    const abs = path.join(artifactRoot, expectedKey);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, "utf8")).toBe(content);

    // The artifact_blobs row carries the content key + sha.
    const blobRow = await client.query(
      `SELECT storage_key, sha256 FROM "${TEST_SCHEMA}"."artifact_blobs" WHERE org_id = $1`,
      [ORG],
    );
    expect(blobRow.rows).toHaveLength(1);
    expect(blobRow.rows[0].storage_key).toBe(expectedKey);
    expect(blobRow.rows[0].sha256).toBe(contentSha);

    // The resource metadata (what the serve resolver reads) binds the key.
    const resourceRow = await client.query(
      `SELECT metadata->>'storageKey' AS k FROM "${TEST_SCHEMA}"."resource" WHERE org_id = $1 AND id = $2`,
      [ORG, res.resourceId],
    );
    expect(resourceRow.rows[0].k).toBe(expectedKey);

    // Storage-key-keyed read round-trips (the serve path's accessor).
    const { createLocalDiskBlobStore } = await import("@/lib/artifacts/local-disk-blob-store");
    const handle = await createLocalDiskBlobStore().openByStorageKey({
      orgId: ORG,
      storageKey: expectedKey,
    });
    let out = "";
    for await (const c of handle.stream) out += new TextDecoder().decode(c);
    expect(out).toBe(content);
  });

  it("same-bytes dedupe → one resource, two artifacts, SHARED final file survives the loser cleanup", async () => {
    const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");
    const res2 = await createSemanticArtifact({
      orgId: ORG,
      createdBy: null,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "926 integration two (dedupe)",
      objectType: FIXTURE_OBJECT_TYPE,
      declaredMime: "text/plain",
      originKind: "agent_generated",
      skipFallbackClassification: true,
      stream: bytes(content),
    });
    expect(res2.resourceId).toBe(firstResourceId); // substance dedupe converged
    expect(res2.artifactId).not.toBe(firstArtifactId); // distinct artifacts kept
    // THE #926 regression pin: the dedupe-loser cleanup must NOT have
    // unlinked the shared content-addressed file.
    expect(existsSync(path.join(artifactRoot, expectedKey))).toBe(true);
    // Still exactly one blob row (dedupe writes no second row).
    const blobRows = await client.query(
      `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."artifact_blobs" WHERE org_id = $1`,
      [ORG],
    );
    expect(blobRows.rows[0].n).toBe(1);
  });

  it("reachability-guarded delete (DEFAULT real-DB probe) keeps an old file while its row lives", async () => {
    const abs = path.join(artifactRoot, expectedKey);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(abs, old, old); // past the grace window → probe decides
    const { createLocalDiskBlobStore } = await import("@/lib/artifacts/local-disk-blob-store");
    await createLocalDiskBlobStore().deleteByStorageKey({ orgId: ORG, storageKey: expectedKey });
    expect(existsSync(abs)).toBe(true); // row exists → kept
  });

  it("verifier (DEFAULT real-DB row lister) reports clean, then the dangling row after unlink", async () => {
    const { verifyArtifactBlobs } = await import("@/lib/artifacts/artifact-blob-verifier");
    const clean = await verifyArtifactBlobs({ orgId: ORG });
    expect(clean.scannedRows).toBe(1);
    expect(clean.danglingRows).toEqual([]);
    expect(clean.orphanFiles).toEqual([]);
    expect(clean.shaMismatches).toEqual([]);

    rmSync(path.join(artifactRoot, expectedKey));
    const broken = await verifyArtifactBlobs({ orgId: ORG });
    expect(broken.danglingRows).toHaveLength(1);
    expect(broken.danglingRows[0].storageKey).toBe(expectedKey);
  });

  it("once no row references the key, the guarded delete removes an old file", async () => {
    // Recreate the file (it was unlinked by the previous test), age it,
    // then remove every referencing row and delete through the store.
    const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");
    await createSemanticArtifact({
      orgId: ORG,
      createdBy: null,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "926 integration three (recreate)",
      objectType: FIXTURE_OBJECT_TYPE,
      declaredMime: "text/plain",
      originKind: "agent_generated",
      skipFallbackClassification: true,
      stream: bytes(content),
    });
    const abs = path.join(artifactRoot, expectedKey);
    expect(existsSync(abs)).toBe(true);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(abs, old, old);
    await client.query(`DELETE FROM "${TEST_SCHEMA}"."artifact_blobs" WHERE org_id = $1`, [ORG]);
    const { createLocalDiskBlobStore } = await import("@/lib/artifacts/local-disk-blob-store");
    await createLocalDiskBlobStore().deleteByStorageKey({ orgId: ORG, storageKey: expectedKey });
    expect(existsSync(abs)).toBe(false); // unreferenced + old → removed
  });
});
