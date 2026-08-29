/**
 * cinatra#3026 (epic #3023, lifecycle-c W2) — THE EDITOR'S SAVE against a REAL
 * Postgres, on the real substrate DDL.
 *
 * These are acceptance items 2, 3, 4 and 5, and only a database can prove them:
 *
 *   2. "A change is saved as one new revision."  — the append allocates exactly
 *      the base's number plus one, once.
 *   3. "A save over a stale base is refused."    — §8.3: "a save that names a
 *      base another save has already built on FAILS ON THAT INDEX, which is the
 *      compare-and-set". The unique index on (org, artifact, revision) is the
 *      mechanism; a stubbed store would agree with whatever the code said, so
 *      the refusal is proved by making Postgres perform it.
 *   4. "A review pinned on an earlier revision still shows that revision."
 *   5. "The audit records the edit."             — an append-only `artifact_audit`
 *      row carrying the base and the new revision.
 *
 * ISOLATION: a fresh schema per file from the CANONICAL
 * `buildCreateStoreSchemaQueries` DDL — the production unique index, the
 * `representation_form_chk` constraint and the append-only trigger included,
 * never hand-rolled drift-prone DDL. Because `postgresSchema` is a module-load
 * const, every app module is dynamically imported in `beforeAll` after the env
 * is set. Mirrors the W3 tier beside it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { Client } from "pg";

vi.mock("@/lib/database", async () => {
  const cfg = await import("@/lib/postgres-config");
  return {
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

// THE LOUD FAILURE HAS TO BE HERE, AT MODULE SCOPE, AND NOT IN A HOOK.
//
// `vitest/integration/3026.config.ts` sets CINATRA_LIFECYCLE_C_W2_REALDB=1 to
// say "you are in the lane that exists to run these", so that a missing
// SUPABASE_DB_URL stops being a quiet skip. The guard used to live in
// `beforeAll` — and never fired: `describe.skipIf(!HAS_REAL_DB)` skips every
// suite in the file, and a file with nothing left to run never runs its
// file-level hooks. The tier reported `6 skipped` and exit 0, which is the exact
// failure this flag was added to prevent: a suite whose only failure mode is
// "skipped" reports success by doing nothing.
//
// A module-scope throw cannot be skipped past. Collection fails, the reason is
// the message, and the run is red.
if (process.env.CINATRA_LIFECYCLE_C_W2_REALDB === "1" && !HAS_REAL_DB) {
  throw new Error(
    "this tier exists to run against a real Postgres, and it was asked to run: " +
      "set SUPABASE_DB_URL to a scratch database. It builds and drops its own " +
      "schema, so any throwaway database will do.",
  );
}
const TEST_SCHEMA = "cinatra_test_w2_editor_3026";
const ORG = "org-3026";
const OTHER_ORG = "org-3026-other";
const GENERIC_ARTIFACT_TYPE = "@cinatra-ai/artifact:object";

let uniq = 0;
const nextId = (p: string) => `${p}-${Date.now()}-${uniq++}`;

let store: typeof import("@/lib/artifacts/representation-store");
let audit: typeof import("@/lib/artifacts/artifact-edit-audit");
let reader: typeof import("@/lib/artifacts/artifact-read");
let runPostgresQueriesAsync: typeof import("@/lib/postgres-async").runPostgresQueriesAsync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;

const S = () => TEST_SCHEMA;

async function sql(text: string, values: unknown[] = []) {
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
  return res;
}

/** A blob-backed resource holding `text`, with the physical blob row beside it —
 *  the shape the artifact writer leaves behind, so the serve resolver can read
 *  the revision that points at it. */
async function seedResource(orgId: string, text: string) {
  const resourceId = nextId("res");
  const blobId = nextId("blob");
  const storageKey = nextId("key");
  const sha = nextId("sha");
  await sql(
    `INSERT INTO "${S()}"."artifact_blobs" (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected)
     VALUES ($1, $2, 'local-disk', $3, $4, $5, 'text/markdown')`,
    [blobId, orgId, storageKey, sha, Buffer.byteLength(text, "utf8")],
  );
  await sql(
    `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, malware_scan_status, metadata)
     VALUES ($1, $2, 'blob', $3, 'text/markdown', $4, 'clean', jsonb_build_object('storageKey', $5::text, 'blobId', $6::text))`,
    [resourceId, orgId, `blob:${sha}`, Buffer.byteLength(text, "utf8"), storageKey, blobId],
  );
  return resourceId;
}

/** A markdown artifact with ONE stored revision — what an editor opens. */
async function seedArtifact(orgId = ORG, text = "# One\n") {
  const artifactId = nextId("art");
  const revisionId = nextId("rev");
  const resourceId = await seedResource(orgId, text);
  await sql(
    `INSERT INTO "${S()}"."objects" (id, org_id, type, data) VALUES ($1, $2, $3, '{}'::jsonb)`,
    [artifactId, orgId, GENERIC_ARTIFACT_TYPE],
  );
  await sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
     VALUES ($1, $2, $3, $4, 1, 'file')`,
    [revisionId, orgId, artifactId, resourceId],
  );
  await sql(
    `INSERT INTO "${S()}"."artifact_audit" (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
     VALUES ($1, $2, $3, $4, 'create', $5, '{}'::jsonb)`,
    [nextId("aud"), orgId, artifactId, revisionId, "seed"],
  );
  return { artifactId, revisionId, resourceId, orgId };
}

async function auditRows(orgId: string, artifactId: string) {
  const res = await sql(
    `SELECT action, representation_revision_id, detail FROM "${S()}"."artifact_audit"
     WHERE org_id=$1 AND artifact_id=$2 ORDER BY created_at ASC, action ASC`,
    [orgId, artifactId],
  );
  return res.rows as Array<{
    action: string;
    representation_revision_id: string;
    detail: Record<string, unknown>;
  }>;
}

beforeAll(async () => {
  // The "asked to run without a database" case is refused at module scope
  // above, where nothing can skip past it. What is left here is the ordinary
  // skip: another config picked this file up and there is no database to use.
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

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

  ({ runPostgresQueriesAsync } = await import("@/lib/postgres-async"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  store = await import("@/lib/artifacts/representation-store");
  audit = await import("@/lib/artifacts/artifact-edit-audit");
  reader = await import("@/lib/artifacts/artifact-read");
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)("enabler 0.20 — the save with an expected base, on the real substrate", () => {
  it("appends ONE new revision, numbered from the base the editor opened", async () => {
    const seeded = await seedArtifact();
    const resourceId = await seedResource(ORG, "# Two\n");

    const appended = await store.appendRepresentationWithExpectedBase({
      orgId: ORG,
      artifactId: seeded.artifactId,
      baseRevisionId: seeded.revisionId,
      resourceId,
      form: "file",
      createdBy: "user-1",
    });

    expect(appended.kind).toBe("appended");
    if (appended.kind !== "appended") return;
    expect(appended.record.revision).toBe(2);

    const all = store.listRepresentations(ORG, seeded.artifactId);
    expect(all.map((r) => r.revision)).toEqual([1, 2]);
    expect(all[1].resourceId).toBe(resourceId);
    expect(all[1].createdBy).toBe("user-1");
  });

  it("REFUSES a save whose base another save already built on — the index is the compare-and-set", async () => {
    const seeded = await seedArtifact();
    const first = await store.appendRepresentationWithExpectedBase({
      orgId: ORG,
      artifactId: seeded.artifactId,
      baseRevisionId: seeded.revisionId,
      resourceId: await seedResource(ORG, "# Two\n"),
      form: "file",
      createdBy: "user-1",
    });
    expect(first.kind).toBe("appended");

    // A second editor opened the SAME base and saves after the first landed.
    const second = await store.appendRepresentationWithExpectedBase({
      orgId: ORG,
      artifactId: seeded.artifactId,
      baseRevisionId: seeded.revisionId,
      resourceId: await seedResource(ORG, "# Three\n"),
      form: "file",
      createdBy: "user-2",
    });

    expect(second.kind).toBe("stale");
    // NOTHING was written over: the artifact still holds exactly the two
    // revisions, and the winner's bytes are still revision 2.
    const all = store.listRepresentations(ORG, seeded.artifactId);
    expect(all.map((r) => r.revision)).toEqual([1, 2]);
    expect(all[1].createdBy).toBe("user-1");
  });

  it("refuses a base that is not this artifact's, or not this organization's", async () => {
    const mine = await seedArtifact();
    const other = await seedArtifact(OTHER_ORG);
    const resourceId = await seedResource(ORG, "# Two\n");

    await expect(
      store.appendRepresentationWithExpectedBase({
        orgId: ORG,
        artifactId: mine.artifactId,
        baseRevisionId: other.revisionId,
        resourceId,
        form: "file",
      }),
    ).resolves.toEqual({ kind: "unknown-base" });

    await expect(
      store.appendRepresentationWithExpectedBase({
        orgId: OTHER_ORG,
        artifactId: mine.artifactId,
        baseRevisionId: mine.revisionId,
        resourceId,
        form: "file",
      }),
    ).resolves.toEqual({ kind: "unknown-base" });

    expect(store.listRepresentations(ORG, mine.artifactId).map((r) => r.revision)).toEqual([1]);
  });

  it("RECORDS THE EDIT with the base and the new revision, in the append's own transaction", async () => {
    const seeded = await seedArtifact();
    const resourceId = await seedResource(ORG, "# Two\n");

    const appended = await store.appendRepresentationWithExpectedBase({
      orgId: ORG,
      artifactId: seeded.artifactId,
      baseRevisionId: seeded.revisionId,
      resourceId,
      form: "file",
      createdBy: "user-1",
      additionalOps: (revisionId) => [
        audit.buildArtifactEditAuditOp(S(), {
          orgId: ORG,
          artifactId: seeded.artifactId,
          representationRevisionId: revisionId,
          baseRepresentationRevisionId: seeded.revisionId,
          baseRevision: 1,
          revision: 2,
          actor: "user-1",
        }),
        audit.buildArtifactEditWitnessOp(S(), {
          orgId: ORG,
          artifactId: seeded.artifactId,
          representationRevisionId: revisionId,
          actor: "user-1",
        }),
      ],
    });
    expect(appended.kind).toBe("appended");
    if (appended.kind !== "appended") return;

    const rows = await auditRows(ORG, seeded.artifactId);
    const edit = rows.find((r) => r.action === "edit");
    expect(edit).toBeDefined();
    expect(edit?.representation_revision_id).toBe(appended.record.id);
    expect(edit?.detail).toMatchObject({
      baseRepresentationRevisionId: seeded.revisionId,
      baseRevision: 1,
      revision: 2,
    });

    // The WITNESS the claimed-row read paths test for rides the same
    // transaction: an edited revision is host-authored exactly as a created one
    // is, or every read gate would stop admitting the artifact after its first
    // edit.
    const witnesses = rows.filter(
      (r) => r.action === "create" && r.representation_revision_id === appended.record.id,
    );
    expect(witnesses).toHaveLength(1);
  });

  it("writes NEITHER the revision NOR the audit when the base is stale", async () => {
    const seeded = await seedArtifact();
    await store.appendRepresentationWithExpectedBase({
      orgId: ORG,
      artifactId: seeded.artifactId,
      baseRevisionId: seeded.revisionId,
      resourceId: await seedResource(ORG, "# Two\n"),
      form: "file",
    });
    const before = (await auditRows(ORG, seeded.artifactId)).length;

    const refused = await store.appendRepresentationWithExpectedBase({
      orgId: ORG,
      artifactId: seeded.artifactId,
      baseRevisionId: seeded.revisionId,
      resourceId: await seedResource(ORG, "# Three\n"),
      form: "file",
      additionalOps: (revisionId) => [
        audit.buildArtifactEditAuditOp(S(), {
          orgId: ORG,
          artifactId: seeded.artifactId,
          representationRevisionId: revisionId,
          baseRepresentationRevisionId: seeded.revisionId,
          baseRevision: 1,
          revision: 2,
          actor: "user-2",
        }),
      ],
    });
    expect(refused.kind).toBe("stale");
    expect((await auditRows(ORG, seeded.artifactId)).length).toBe(before);
  });

  it("RETHROWS a unique violation that is NOT the revision index — a defect is not a stale save", async () => {
    // THE COMPARE-AND-SET IS ONE INDEX. A spliced ledger op that violates some
    // OTHER unique constraint is a defect in that op, and answering `stale`
    // would tell the person their document moved when it did not and send the
    // editor to reload a revision nobody changed. Here the spliced op inserts a
    // representation row with an id that already exists — the PRIMARY KEY, never
    // `representation_artifact_rev_idx`.
    const seeded = await seedArtifact();
    const resourceId = await seedResource(ORG, "# Two\n");

    await expect(
      store.appendRepresentationWithExpectedBase({
        orgId: ORG,
        artifactId: seeded.artifactId,
        baseRevisionId: seeded.revisionId,
        resourceId,
        form: "file",
        createdBy: "user-1",
        additionalOps: () => [
          {
            text: `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
                   VALUES ($1, $2, $3, $4, 99, 'file')`,
            values: [seeded.revisionId, ORG, seeded.artifactId, resourceId],
          },
        ],
      }),
    ).rejects.toThrow(/duplicate key/i);

    // And the transaction took the revision with it: the artifact still holds
    // exactly what it held.
    expect(store.listRepresentations(ORG, seeded.artifactId).map((r) => r.revision)).toEqual([1]);
  });

  it("leaves a REVIEW'S PINNED REVISION exactly where it was under an edit", async () => {
    const seeded = await seedArtifact(ORG, "# The reviewed draft\n");
    // What the review froze: the revision the gate pinned, and its bytes.
    const pinned = reader.resolveArtifactVersionForServe({
      orgId: ORG,
      artifactId: seeded.artifactId,
      representationRevisionId: seeded.revisionId,
    });
    expect(pinned).not.toBeNull();

    const appended = await store.appendRepresentationWithExpectedBase({
      orgId: ORG,
      artifactId: seeded.artifactId,
      baseRevisionId: seeded.revisionId,
      resourceId: await seedResource(ORG, "# Edited after the review opened\n"),
      form: "file",
      createdBy: "user-1",
    });
    expect(appended.kind).toBe("appended");

    // The artifact moved on…
    expect(store.getLatestRepresentation(ORG, seeded.artifactId)?.revision).toBe(2);
    // …and the pinned revision did not: same row, same resource, same bytes.
    const afterEdit = reader.resolveArtifactVersionForServe({
      orgId: ORG,
      artifactId: seeded.artifactId,
      representationRevisionId: seeded.revisionId,
    });
    expect(afterEdit).toEqual(pinned);
    expect(store.listRepresentations(ORG, seeded.artifactId)[0].id).toBe(seeded.revisionId);
  });
});
