/**
 * REAL-STORE PROOF — REGENERATE'S SUCCESSOR IS A NEW REVISION OF THE SAME
 * ARTIFACT (cinatra#3080, fix leg 8).
 *
 * The ninth proof round read two rows off a real run and they named two
 * artifacts: gate `d6301eed` pinned artifact `90dbf854` / revision `588f62bb`;
 * its successor `096296ae` pinned artifact `d8eca6bd` / revision `f2434774`.
 * The drawing says one artifact and two revisions — Regenerate "files a new
 * revision of the same artifact, and settles this gate superseded beneath a
 * successor over that same artifact" (Agent run & review §VI).
 *
 * This suite reads BOTH PINS out of a real Postgres against the canonical DDL,
 * the way the proof round reads them off the lane database: the artifact id the
 * append returns must be the artifact id it was given, the revision must be new,
 * the append-only `representation` table must carry both rows under that one
 * artifact, and the artifact's own envelope must point at the newer one.
 *
 * Isolation mirrors the CMS capture suite: a fresh schema per file from
 * `buildCreateStoreSchemaQueries`, a temp blob root, app modules imported after
 * the env is set, guarded by `describe.skipIf(!HAS_REAL_DB)`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const TEST_SCHEMA = "cinatra_test_revision_append_3080";
const ORG = "org-3080-leg8";

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let appendMod: typeof import("@/lib/artifacts/artifact-revision-append");

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

async function* bytes(s: string): AsyncIterable<Uint8Array> {
  yield new Uint8Array(Buffer.from(s, "utf-8"));
}

/** The artifact a run's first revision would have left behind. */
function seedArtifact(): { artifactId: string; revisionId: string } {
  const artifactId = randomUUID();
  const revisionId = randomUUID();
  const resourceId = randomUUID();
  const blobId = randomUUID();
  sql(
    `INSERT INTO "${S()}"."objects" (id, type, data, org_id, created_by, owner_level, owner_id, visibility)
     VALUES ($1::text, $2::text, $3::jsonb, $4::text, NULL, 'organization', $4::text, 'organization')`,
    [
      artifactId,
      "@cinatra-ai/blog-post-artifact:post",
      JSON.stringify({
        artifactType: "file",
        latestRepresentationRevisionId: revisionId,
        latestDigest: "seed-digest",
        mime: "text/markdown",
        size: 11,
        originKind: "agent_generated",
        viewerHint: "mime",
        title: "The first draft",
      }),
      ORG,
    ],
  );
  sql(
    `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
     VALUES ($1::text, $2::text, 'blob', $3::text, 'text/markdown', 11, NULL,
             jsonb_build_object('storageKey', $4::text, 'blobId', $5::text))`,
    [resourceId, ORG, `blob:seed-${artifactId}`, `orgs/${ORG}/blobs/seed.bin`, blobId],
  );
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1::text, $2::text, $3::text, $4::text, 1, 'file')`,
    [revisionId, ORG, artifactId, resourceId],
  );
  return { artifactId, revisionId };
}

/**
 * A producing run's own output row bound to a resource THAT ALREADY EXISTS —
 * the shape a deterministic regeneration leaves behind. Identical bytes resolve,
 * through the org-scoped substance key, to the very same `resource` row the
 * reviewed revision binds; this seeds exactly that.
 */
function seedProducedRevisionOnResource(resourceId: string, runId: string): {
  artifactId: string;
  revisionId: string;
} {
  const artifactId = randomUUID();
  const revisionId = randomUUID();
  sql(
    `INSERT INTO "${S()}"."objects" (id, type, data, org_id, created_by, owner_level, owner_id, visibility)
     VALUES ($1::text, $2::text, $3::jsonb, $4::text, NULL, 'organization', $4::text, 'organization')`,
    [
      artifactId,
      "@cinatra-ai/blog-post-artifact:post",
      JSON.stringify({
        artifactType: "file",
        latestRepresentationRevisionId: revisionId,
        mime: "text/markdown",
        size: 11,
        originKind: "agent_generated",
      }),
      ORG,
    ],
  );
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form, created_by_run_id)
     VALUES ($1::text, $2::text, $3::text, $4::text, 1, 'file', $5::text)`,
    [revisionId, ORG, artifactId, resourceId, runId],
  );
  return { artifactId, revisionId };
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3080-leg8-"));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist")) throw err;
    }
  }
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  appendMod = await import("@/lib/artifacts/artifact-revision-append");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("§VI — the successor's pins, read out of a real store", () => {
  it("keeps the ARTIFACT and moves only the REVISION", async () => {
    const seed = seedArtifact();

    const appended = await appendMod.appendSemanticArtifactRevision({
      orgId: ORG,
      artifactId: seed.artifactId,
      declaredMime: "text/markdown",
      title: "The first draft",
      stream: bytes("# The first draft\n\nTightened, as the note asked.\n"),
      createdByRunId: null,
    });

    // THE TWO PINS, the pair the proof round reads off the two gates.
    expect(appended.artifactId).toBe(seed.artifactId);
    expect(appended.representationRevisionId).not.toBe(seed.revisionId);
    expect(appended.revision).toBe(2);

    // The append-only table carries BOTH revisions, under the ONE artifact.
    const reps = sql(
      `SELECT id, revision FROM "${S()}"."representation"
        WHERE org_id=$1 AND artifact_id=$2 ORDER BY revision ASC`,
      [ORG, seed.artifactId],
    );
    expect((reps.rows ?? []).map((r) => (r as { revision: number }).revision)).toEqual([1, 2]);
    expect((reps.rows ?? []).map((r) => (r as { id: string }).id)).toEqual([
      seed.revisionId,
      appended.representationRevisionId,
    ]);

    // No second artifact was minted — the whole point.
    const objects = sql(`SELECT count(*)::int AS n FROM "${S()}"."objects" WHERE org_id=$1`, [ORG]);
    expect(Number((objects.rows?.[0] as { n: number }).n)).toBe(1);

    // The artifact's own envelope points at the newer revision.
    const envelope = sql(`SELECT data FROM "${S()}"."objects" WHERE id=$1`, [seed.artifactId]);
    const data = (envelope.rows?.[0] as { data: Record<string, unknown> }).data;
    expect(data.latestRepresentationRevisionId).toBe(appended.representationRevisionId);
    expect(data.latestDigest).toBe(appended.sha256);
    expect(data.mime).toBe("text/markdown");
    // And keeps what it already carried.
    expect(data.artifactType).toBe("file");
    expect(data.originKind).toBe("agent_generated");

    // The writer provenance witness rides the same transaction as the revision.
    const witness = sql(
      `SELECT count(*)::int AS n FROM "${S()}"."artifact_audit"
        WHERE org_id=$1 AND artifact_id=$2 AND representation_revision_id=$3 AND action='create'`,
      [ORG, seed.artifactId, appended.representationRevisionId],
    );
    expect(Number((witness.rows?.[0] as { n: number }).n)).toBe(1);
  });

  it("appends again — revision 3, still one artifact", async () => {
    const seed = seedArtifact();
    await appendMod.appendSemanticArtifactRevision({
      orgId: ORG,
      artifactId: seed.artifactId,
      declaredMime: "text/markdown",
      stream: bytes("second\n"),
    });
    const third = await appendMod.appendSemanticArtifactRevision({
      orgId: ORG,
      artifactId: seed.artifactId,
      declaredMime: "text/markdown",
      stream: bytes("third\n"),
    });
    expect(third.artifactId).toBe(seed.artifactId);
    expect(third.revision).toBe(3);
  });

  it("RE-FILES a producing run's own output as the reviewed artifact's next revision", async () => {
    // The shape the real completion road meets: the repair run answered by
    // writing its work under an artifact of its own, and the successor must be a
    // revision of the artifact the reviewer pinned.
    const reviewed = seedArtifact();
    const produced = seedArtifact();

    const refiled = appendMod.refileRevisionOntoArtifact({
      orgId: ORG,
      targetArtifactId: reviewed.artifactId,
      sourceArtifactId: produced.artifactId,
      sourceRepresentationRevisionId: produced.revisionId,
      createdByRunId: "run-repair-1",
    });

    expect(refiled.artifactId).toBe(reviewed.artifactId);
    expect(refiled.revision).toBe(2);
    expect(refiled.reused).toBe(false);

    // The SAME substance is bound — no second blob, no copy.
    const bound = sql(
      `SELECT r.resource_id FROM "${S()}"."representation" r WHERE r.id=$1`,
      [refiled.representationRevisionId],
    );
    const sourceResource = sql(
      `SELECT r.resource_id FROM "${S()}"."representation" r WHERE r.id=$1`,
      [produced.revisionId],
    );
    expect((bound.rows?.[0] as { resource_id: string }).resource_id).toBe(
      (sourceResource.rows?.[0] as { resource_id: string }).resource_id,
    );

    // The producing run keeps its own output row exactly as it wrote it.
    const producedReps = sql(
      `SELECT count(*)::int AS n FROM "${S()}"."representation" WHERE artifact_id=$1`,
      [produced.artifactId],
    );
    expect(Number((producedReps.rows?.[0] as { n: number }).n)).toBe(1);

    // A RE-DRIVE files nothing new — it hands back the revision already there.
    const again = appendMod.refileRevisionOntoArtifact({
      orgId: ORG,
      targetArtifactId: reviewed.artifactId,
      sourceArtifactId: produced.artifactId,
      sourceRepresentationRevisionId: produced.revisionId,
      createdByRunId: "run-repair-1",
    });
    expect(again.representationRevisionId).toBe(refiled.representationRevisionId);
    expect(again.reused).toBe(true);
  });

  it("REFUSES a tombstoned target — the row's own deleted_at, not a payload flag", async () => {
    const seed = seedArtifact();
    sql(`UPDATE "${S()}"."objects" SET deleted_at = now() WHERE id=$1`, [seed.artifactId]);
    await expect(
      appendMod.appendSemanticArtifactRevision({
        orgId: ORG,
        artifactId: seed.artifactId,
        declaredMime: "text/markdown",
        stream: bytes("a repair against a dead target\n"),
      }),
    ).rejects.toMatchObject({ code: "artifact-tombstoned" });
    const reps = sql(
      `SELECT count(*)::int AS n FROM "${S()}"."representation" WHERE artifact_id=$1`,
      [seed.artifactId],
    );
    expect(Number((reps.rows?.[0] as { n: number }).n)).toBe(1);
  });

  it("BYTE-IDENTICAL work still files a NEW revision — the re-drive is the run, never the substance", async () => {
    // THE CONVERGENCE FINDING THIS PINS (cinatra#3080, fix leg 8). This door's
    // first shape keyed its idempotence on the SUBSTANCE: any revision of the
    // target already binding the same resource was handed back as "already
    // filed". A regeneration is free to answer with bytes identical to the
    // revision under review — the same step, the same note, a deterministic
    // producer — and identical bytes resolve to the very same `resource` row the
    // reviewed revision binds. The probe would then have returned THE BASE
    // REVISION ITSELF as the successor, `validateRepairLineage` refuses that
    // `successor-equals-base`, and the repair could never complete: every later
    // drain re-files nothing and is refused again, for good.
    //
    // The drawing is unconditional — Regenerate "files a new revision of the
    // same artifact" (Agent run & review §VI) — so identical bytes from another
    // run are a NEW revision.
    const reviewed = seedArtifact();
    const reviewedResource = String(
      (sql(`SELECT resource_id FROM "${S()}"."representation" WHERE id=$1`, [reviewed.revisionId])
        .rows?.[0] as { resource_id: string }).resource_id,
    );
    const produced = seedProducedRevisionOnResource(reviewedResource, "run-repair-identical");

    const refiled = appendMod.refileRevisionOntoArtifact({
      orgId: ORG,
      targetArtifactId: reviewed.artifactId,
      sourceArtifactId: produced.artifactId,
      sourceRepresentationRevisionId: produced.revisionId,
      createdByRunId: "run-repair-identical",
    });

    // NOT the base revision handed back, and not a reuse.
    expect(refiled.representationRevisionId).not.toBe(reviewed.revisionId);
    expect(refiled.reused).toBe(false);
    expect(refiled.revision).toBe(2);
    expect(refiled.artifactId).toBe(reviewed.artifactId);

    // Two revisions of the ONE artifact, both binding the one resource — the
    // append-only series, with no second blob written.
    const reps = sql(
      `SELECT revision, resource_id FROM "${S()}"."representation" WHERE artifact_id=$1 ORDER BY revision`,
      [reviewed.artifactId],
    );
    expect((reps.rows ?? []).length).toBe(2);
    for (const row of reps.rows as Array<{ resource_id: string }>) {
      expect(row.resource_id).toBe(reviewedResource);
    }

    // And THIS run's re-drive is still idempotent — the mark is the run.
    const again = appendMod.refileRevisionOntoArtifact({
      orgId: ORG,
      targetArtifactId: reviewed.artifactId,
      sourceArtifactId: produced.artifactId,
      sourceRepresentationRevisionId: produced.revisionId,
      createdByRunId: "run-repair-identical",
    });
    expect(again.representationRevisionId).toBe(refiled.representationRevisionId);
    expect(again.reused).toBe(true);
  });

  it("REFUSES a tombstoned target on the RE-FILE door too — nothing written", async () => {
    // The bytes door was proved above; the re-file door is the one the real
    // completion road takes, and it takes the same row lock and the same
    // refusal (a convergence finding on this leg added the row lock: the
    // advisory lock serialises cooperating revision writers, never an ordinary
    // tombstone, so the target's own row is locked FOR UPDATE inside the
    // transaction and the liveness it reads holds for every statement after it).
    const reviewed = seedArtifact();
    const produced = seedArtifact();
    sql(`UPDATE "${S()}"."objects" SET deleted_at = now() WHERE id=$1`, [reviewed.artifactId]);
    expect(() =>
      appendMod.refileRevisionOntoArtifact({
        orgId: ORG,
        targetArtifactId: reviewed.artifactId,
        sourceArtifactId: produced.artifactId,
        sourceRepresentationRevisionId: produced.revisionId,
        createdByRunId: "run-repair-dead",
      }),
    ).toThrowError(/tombstoned/);
    const reps = sql(
      `SELECT count(*)::int AS n FROM "${S()}"."representation" WHERE artifact_id=$1`,
      [reviewed.artifactId],
    );
    expect(Number((reps.rows?.[0] as { n: number }).n)).toBe(1);
  });

  it("REFUSES to create — an artifact this org does not own gets no revision", async () => {
    await expect(
      appendMod.appendSemanticArtifactRevision({
        orgId: ORG,
        artifactId: randomUUID(),
        declaredMime: "text/markdown",
        stream: bytes("nothing to append to\n"),
      }),
    ).rejects.toMatchObject({ code: "artifact-absent" });
  });
});
