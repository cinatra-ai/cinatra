/**
 * cinatra#923 — artifact-materialization idempotency ledger, REAL-SURFACE
 * integration test (no mocks on the DB path).
 *
 * Guarded by `describe.skipIf(!HAS_REAL_DB)` like
 * `artifact-blob-store-content-addressed.test.ts`: CI without a reachable
 * Postgres emits zero failures and zero noise. With a real
 * `SUPABASE_DB_URL` it drives:
 *
 *   1. the drizzle-store DDL against a fresh per-test schema (including the
 *      new `artifact_materializations` table + its 4-part unique index);
 *   2. claim → createSemanticArtifact with the tx-composed FINALIZE op →
 *      the finalize commits ATOMICALLY with the artifact write;
 *   3. a re-drive (duplicate claim on the same identity) returns the
 *      finalized refs instead of a fresh claim — never a second artifact;
 *   4. a crash-before-write drive (claim never finalized) is RE-USED by the
 *      next claim (same ledger id);
 *   5. the advisory WARN-phase lookup finds ONLY finalized
 *      `end_node_binding` rows (an `llm_emit` provenance row of the same
 *      run/extension/hash does not suppress).
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

vi.mock("@/lib/database", () => ({
  readChatThreadForClassifier: () => null,
  readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
  writeMetadataValueToDatabase: () => {},
  // producer-assertions resolves its DB surface through @/lib/database —
  // point it at the same real test DB/schema (its agent_runs lookup then
  // finds nothing for the fake run id and degrades fail-soft, which is the
  // posture this suite wants).
  ensurePostgresSchema: () => {},
  getPostgresConnectionString: () => process.env.SUPABASE_DB_URL ?? "",
  get postgresSchema() {
    return process.env.SUPABASE_SCHEMA ?? "public";
  },
}));

const TEST_SCHEMA = "cinatra_test_artifact_matln_923";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

const ORG = "org-int-923";
const RUN = "run-int-923";
const EXT = "@cinatra-ai/blog-post-artifact";

async function* bytes(s: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(s);
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe.skipIf(!HAS_REAL_DB)("cinatra#923 materialization ledger (real DB)", () => {
  let client: Client;
  let artifactRoot: string;
  let priorSchemaEnv: string | undefined;
  let priorRootEnv: string | undefined;

  beforeAll(async () => {
    priorSchemaEnv = process.env.SUPABASE_SCHEMA;
    priorRootEnv = process.env.CINATRA_ARTIFACT_DATA_ROOT;
    process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
    artifactRoot = mkdtempSync(path.join(tmpdir(), "cin-923-int-"));
    process.env.CINATRA_ARTIFACT_DATA_ROOT = artifactRoot;

    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);

    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const q of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = q.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") {
        continue;
      }
      try {
        await client.query(q.text, (q as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist")) throw err;
      }
    }
    (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;
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

  const content = "cinatra#923 declarative payload";
  const contentHash = sha(content);
  let firstArtifactId = "";
  let firstRepresentationId = "";

  it("provisions artifact_materializations with the 4-part unique identity index", async () => {
    const res = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'artifact_materializations'`,
      [TEST_SCHEMA],
    );
    const names = res.rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain("artifact_materializations_identity_idx");
  });

  it("claim → write-with-finalize commits the artifact AND the finalized row atomically", async () => {
    const { claimMaterialization, buildFinalizeMaterializationQuery } = await import(
      "@/lib/artifacts/materialization-ledger"
    );
    const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");

    const claim = await claimMaterialization({
      orgId: ORG,
      runId: RUN,
      outputId: "draft",
      nodeId: "endNode",
      path: "end_node_binding",
      extension: EXT,
      contentHash,
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    const created = await createSemanticArtifact({
      orgId: ORG,
      createdBy: null,
      ownerLevel: "organization",
      ownerId: ORG,
      title: "923 declarative one",
      declaredMime: "text/plain",
      originKind: "agent_generated",
      skipFallbackClassification: true,
      // A run id with NO agent_runs row: the producer plan degrades to no
      // assertion (fail-soft) — the atomic-finalize path is what this test
      // pins, not producer resolution.
      createdByRunId: RUN,
      producerAssertionExtension: EXT,
      stream: bytes(content),
      additionalTx2Queries: (ids) => [
        buildFinalizeMaterializationQuery({
          ledgerId: claim.ledgerId,
          orgId: ORG,
          artifactId: ids.artifactId,
          representationRevisionId: ids.representationRevisionId,
        }),
      ],
    });
    firstArtifactId = created.artifactId;
    firstRepresentationId = created.representationRevisionId;

    const row = await client.query(
      `SELECT phase, artifact_id, representation_revision_id
         FROM "${TEST_SCHEMA}"."artifact_materializations" WHERE id = $1`,
      [claim.ledgerId],
    );
    expect(row.rows[0]).toEqual({
      phase: "finalized",
      artifact_id: created.artifactId,
      representation_revision_id: created.representationRevisionId,
    });
  });

  it("a re-drive on the same identity returns the finalized refs (no second artifact)", async () => {
    const { claimMaterialization } = await import("@/lib/artifacts/materialization-ledger");
    const again = await claimMaterialization({
      orgId: ORG,
      runId: RUN,
      outputId: "draft",
      nodeId: "endNode",
      path: "end_node_binding",
      extension: EXT,
      contentHash,
    });
    expect(again).toEqual({
      kind: "finalized",
      artifactId: firstArtifactId,
      representationRevisionId: firstRepresentationId,
    });
  });

  it("an unfinalized (crashed) claim is re-used by the next drive", async () => {
    const { claimMaterialization } = await import("@/lib/artifacts/materialization-ledger");
    const crashHash = sha("crashed drive");
    const first = await claimMaterialization({
      orgId: ORG,
      runId: RUN,
      outputId: "other",
      nodeId: "endNode",
      path: "end_node_binding",
      extension: EXT,
      contentHash: crashHash,
    });
    expect(first.kind).toBe("claimed");
    const second = await claimMaterialization({
      orgId: ORG,
      runId: RUN,
      outputId: "other",
      nodeId: "endNode",
      path: "end_node_binding",
      extension: EXT,
      contentHash: crashHash,
    });
    expect(second).toEqual(first); // same ledger id — the claim is re-used
  });

  it("the finalize guard ABORTS the loser's whole Tx2 (no second artifact) and the winner's refs are recoverable", async () => {
    const {
      claimMaterialization,
      buildFinalizeMaterializationQuery,
      isMaterializationFinalizeConflict,
      readFinalizedMaterialization,
    } = await import("@/lib/artifacts/materialization-ledger");
    const { createSemanticArtifact } = await import("@/lib/artifacts/artifact-creation");

    const raceHash = sha("concurrent double-drive bytes");
    const claim = await claimMaterialization({
      orgId: ORG,
      runId: RUN,
      outputId: "raced",
      nodeId: "endNode",
      path: "end_node_binding",
      extension: EXT,
      contentHash: raceHash,
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;

    // Simulate the WINNER: finalize the claim out-of-band (as a concurrent
    // drive's committed Tx2 would).
    await client.query(
      `UPDATE "${TEST_SCHEMA}"."artifact_materializations"
          SET phase='finalized', artifact_id='art-winner', representation_revision_id='rep-winner'
        WHERE id = $1`,
      [claim.ledgerId],
    );

    const before = await client.query(
      `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."objects" WHERE org_id = $1`,
      [ORG],
    );

    // The LOSER drives the write with the same (now-finalized) claim: the
    // guard must abort the WHOLE Tx2 — artifact rows included.
    let thrown: unknown = null;
    try {
      await createSemanticArtifact({
        orgId: ORG,
        createdBy: null,
        ownerLevel: "organization",
        ownerId: ORG,
        title: "923 loser drive",
        declaredMime: "text/plain",
        originKind: "agent_generated",
        skipFallbackClassification: true,
        stream: bytes("concurrent double-drive bytes"),
        additionalTx2Queries: (ids) => [
          buildFinalizeMaterializationQuery({
            ledgerId: claim.ledgerId,
            orgId: ORG,
            artifactId: ids.artifactId,
            representationRevisionId: ids.representationRevisionId,
          }),
        ],
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(isMaterializationFinalizeConflict(thrown)).toBe(true);

    // No second artifact committed (objects count unchanged).
    const after = await client.query(
      `SELECT count(*)::int AS n FROM "${TEST_SCHEMA}"."objects" WHERE org_id = $1`,
      [ORG],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // The winner's refs are recoverable through the loser's recovery read.
    expect(
      await readFinalizedMaterialization({ orgId: ORG, ledgerId: claim.ledgerId }),
    ).toEqual({ artifactId: "art-winner", representationRevisionId: "rep-winner" });

    // And the guard did NOT constant-fold: a still-claimed row finalizes
    // fine through the same query shape (the happy path in the first test
    // above already proved this; assert the raced row kept the winner's refs).
    const row = await client.query(
      `SELECT artifact_id FROM "${TEST_SCHEMA}"."artifact_materializations" WHERE id = $1`,
      [claim.ledgerId],
    );
    expect(row.rows[0].artifact_id).toBe("art-winner");
  });

  it("advisory lookup finds ONLY finalized end_node_binding rows", async () => {
    const {
      findFinalizedDeclarativeMaterialization,
      recordLlmEmitMaterialization,
    } = await import("@/lib/artifacts/materialization-ledger");

    const hit = await findFinalizedDeclarativeMaterialization({
      orgId: ORG,
      runId: RUN,
      extension: EXT,
      contentHash,
    });
    expect(hit).toEqual({
      artifactId: firstArtifactId,
      representationRevisionId: firstRepresentationId,
    });

    // Wrong org / other run / other hash → null.
    expect(
      await findFinalizedDeclarativeMaterialization({
        orgId: "org-other",
        runId: RUN,
        extension: EXT,
        contentHash,
      }),
    ).toBeNull();
    expect(
      await findFinalizedDeclarativeMaterialization({
        orgId: ORG,
        runId: RUN,
        extension: EXT,
        contentHash: sha("different bytes"),
      }),
    ).toBeNull();

    // An llm_emit provenance row of a DIFFERENT run/hash never suppresses:
    // record one and prove the declarative lookup ignores llm_emit paths.
    const emitHash = sha("emit-only bytes");
    await recordLlmEmitMaterialization({
      orgId: ORG,
      runId: RUN,
      authoringStepId: "step-1",
      extension: EXT,
      contentHash: emitHash,
      artifactId: "art-emit",
      representationRevisionId: "rep-emit",
    });
    expect(
      await findFinalizedDeclarativeMaterialization({
        orgId: ORG,
        runId: RUN,
        extension: EXT,
        contentHash: emitHash,
      }),
    ).toBeNull();
  });
});
