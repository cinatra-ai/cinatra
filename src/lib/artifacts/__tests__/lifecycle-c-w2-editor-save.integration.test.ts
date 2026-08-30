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
let ports: typeof import("@/lib/artifacts/artifact-edit-save-ports");
let blobs: typeof import("@/lib/artifacts/local-disk-blob-store");
let channel: typeof import("@/lib/artifacts/artifact-content-channel");
let pinnedText: typeof import("@/lib/artifacts/artifact-pinned-text");
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
  ports = await import("@/lib/artifacts/artifact-edit-save-ports");
  blobs = await import("@/lib/artifacts/local-disk-blob-store");
  channel = await import("@/lib/artifacts/artifact-content-channel");
  pinnedText = await import("@/lib/artifacts/artifact-pinned-text");
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

/**
 * THE BASE-REVISION READ, against the real objects table.
 *
 * `readLatest` answers "does this artifact exist, in this organization, and is
 * it not tombstoned" through the objects substrate's own accessor rather than a
 * raw join of its own. Only a real database can show that the substrate read
 * carries the SAME two conditions the join carried: a tombstoned artifact and a
 * foreign organization's artifact must both come back with NO latest revision,
 * so the save road refuses before it ever names a base.
 */
describe.skipIf(!HAS_REAL_DB)("enabler 0.20 — the base-revision read is scoped by the objects substrate", () => {
  const readLatest = (orgId: string, artifactId: string) =>
    ports
      .artifactEditSavePorts({
        actor: {} as never,
        orgId,
        artifactId,
      })
      .readLatest({ orgId, artifactId });

  it("reads the latest revision while the artifact lives, and NOTHING once it is tombstoned", async () => {
    const seeded = await seedArtifact();

    const live = await readLatest(ORG, seeded.artifactId);
    expect(live?.revisionId).toBe(seeded.revisionId);
    expect(live?.revision).toBe(1);

    await sql(
      `UPDATE "${S()}"."objects" SET deleted_at = now() WHERE id = $1 AND org_id = $2`,
      [seeded.artifactId, ORG],
    );

    // The representation rows are untouched — the refusal comes from the
    // artifact's own row being tombstoned, exactly as the removed join required.
    const reps = await sql(
      `SELECT id FROM "${S()}"."representation" WHERE org_id=$1 AND artifact_id=$2`,
      [ORG, seeded.artifactId],
    );
    expect(reps.rows.length).toBe(1);

    expect(await readLatest(ORG, seeded.artifactId)).toBeNull();
  });

  it("reads NOTHING for an artifact that belongs to another organization", async () => {
    const foreign = await seedArtifact(OTHER_ORG);

    expect((await readLatest(OTHER_ORG, foreign.artifactId))?.revisionId).toBe(
      foreign.revisionId,
    );
    expect(await readLatest(ORG, foreign.artifactId)).toBeNull();
  });

  it("reads NOTHING for an artifact that does not exist at all", async () => {
    expect(await readLatest(ORG, nextId("art-absent"))).toBeNull();
  });
});

/**
 * THE REVISION A FRESHLY OPENED EDITOR OPENS ON (enabler 0.20).
 *
 * The artifact row carries a CACHED pointer at its latest representation,
 * written once when the artifact is created. The edit-save road appends
 * revisions without touching it, so after any edit the cached pointer names a
 * revision that is no longer the head — and an editor that opened on it would
 * hand every later save a base the store has already built on, which the
 * compare-and-set above correctly refuses. The reader would then be told their
 * own first save was stale.
 *
 * So the editor resolves its revision from the STORE, not from the cache. This
 * suite pins both halves against the real substrate: the cache does go stale
 * (it is not a hypothetical), and the resolver ignores it and answers the head.
 *
 * The review surfaces are unaffected by construction — they are handed the
 * revision the gate pinned and never ask for a latest at all; the suite above
 * ("leaves a REVIEW'S PINNED REVISION exactly where it was under an edit")
 * holds that line.
 */
describe.skipIf(!HAS_REAL_DB)("enabler 0.20 — the editor opens on the HEAD revision", () => {
  /** Seed the cached pointer the way artifact creation writes it. */
  async function cachePointer(orgId: string, artifactId: string, revisionId: string) {
    await sql(
      `UPDATE "${S()}"."objects"
         SET data = jsonb_set(data, '{latestRepresentationRevisionId}', to_jsonb($3::text), true)
       WHERE id = $1 AND org_id = $2`,
      [artifactId, orgId, revisionId],
    );
  }

  async function cachedPointer(orgId: string, artifactId: string): Promise<string | null> {
    const res = await sql(
      `SELECT data->>'latestRepresentationRevisionId' AS ptr FROM "${S()}"."objects"
       WHERE id = $1 AND org_id = $2`,
      [artifactId, orgId],
    );
    return (res.rows[0] as { ptr: string | null } | undefined)?.ptr ?? null;
  }

  /** Append `count` further revisions, returning the head revision's id. */
  async function appendRevisions(
    orgId: string,
    artifactId: string,
    from: string,
    count: number,
  ): Promise<string> {
    let base = from;
    for (let n = 0; n < count; n += 1) {
      const resourceId = await seedResource(orgId, `# Revision ${n + 2}\n`);
      const appended = await store.appendRepresentationWithExpectedBase({
        orgId,
        artifactId,
        baseRevisionId: base,
        resourceId,
        form: "file",
        createdBy: "user-1",
      });
      if (appended.kind !== "appended") throw new Error(`append ${n + 2} was ${appended.kind}`);
      base = appended.record.id;
    }
    return base;
  }

  it("THE CACHED POINTER GOES STALE — it still names revision 1 after two edits", async () => {
    const seeded = await seedArtifact();
    await cachePointer(ORG, seeded.artifactId, seeded.revisionId);

    const head = await appendRevisions(ORG, seeded.artifactId, seeded.revisionId, 2);

    expect(store.listRepresentations(ORG, seeded.artifactId).map((r) => r.revision)).toEqual([
      1, 2, 3,
    ]);
    expect(head).not.toBe(seeded.revisionId);
    // The defect, stated as a fact about the substrate rather than about a page.
    expect(await cachedPointer(ORG, seeded.artifactId)).toBe(seeded.revisionId);
  });

  it("resolves the HEAD revision for the editor, not the cached pointer", async () => {
    const seeded = await seedArtifact();
    await cachePointer(ORG, seeded.artifactId, seeded.revisionId);
    const head = await appendRevisions(ORG, seeded.artifactId, seeded.revisionId, 2);

    // THREE independent resolutions, the way three fresh loads ask.
    for (let load = 0; load < 3; load += 1) {
      expect(
        store.resolveEditorRevisionId(ORG, seeded.artifactId, seeded.revisionId),
      ).toBe(head);
    }
  });

  it("falls back to the cached pointer only when the store holds no revision at all", async () => {
    const artifactId = nextId("art-empty");
    await sql(
      `INSERT INTO "${S()}"."objects" (id, org_id, type, data) VALUES ($1, $2, $3, '{}'::jsonb)`,
      [artifactId, ORG, GENERIC_ARTIFACT_TYPE],
    );
    expect(store.listRepresentations(ORG, artifactId)).toEqual([]);
    expect(store.resolveEditorRevisionId(ORG, artifactId, "rev-cached")).toBe("rev-cached");
    expect(store.resolveEditorRevisionId(ORG, artifactId, null)).toBeNull();
  });

  it("never crosses organizations — another org's head is not this org's", async () => {
    const foreign = await seedArtifact(OTHER_ORG);
    await appendRevisions(OTHER_ORG, foreign.artifactId, foreign.revisionId, 1);

    expect(store.resolveEditorRevisionId(ORG, foreign.artifactId, null)).toBeNull();
  });
});

/**
 * THE REVIEW CARD DRAWS THE PINNED REVISION'S DOCUMENT (enabler 0.3 wired for
 * this consumer, enabler 0.20).
 *
 * The card's props builder used to hand every display an ABSENT content
 * projection. A markdown display handed one draws its named floor — no document
 * body, and no tabs, because a floor has nothing to switch between — over a
 * revision whose text was in the store the whole time. This suite reads the real
 * bytes off the real blob store through the real binder, so "the card shows the
 * work" is a property of the wiring rather than of a fixture.
 *
 * AND IT READS THE PINNED REVISION, NOT THE HEAD: the artifact is edited twice
 * after the gate pins revision 1, and the card still carries revision 1's own
 * characters. That is the difference between showing what was approved and
 * showing whatever the artifact became.
 */
describe.skipIf(!HAS_REAL_DB)("enabler 0.20 — the review card carries the pinned revision's text", () => {
  /** A resource whose bytes are REALLY on the blob store, addressable by key. */
  async function seedRealResource(orgId: string, artifactId: string, revisionId: string, text: string) {
    const record = await blobs.createLocalDiskBlobStore().put({
      orgId,
      artifactId,
      representationRevisionId: revisionId,
      stream: (async function* () {
        yield new TextEncoder().encode(text);
      })(),
      declaredMime: "text/markdown",
      maxBytes: 1024 * 1024,
    });
    const resourceId = nextId("res");
    await sql(
      `INSERT INTO "${S()}"."artifact_blobs" (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected)
       VALUES ($1, $2, 'local-disk', $3, $4, $5, 'text/markdown')`,
      [record.blobId, orgId, record.storageKey, record.sha256, record.sizeBytes],
    );
    await sql(
      `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, malware_scan_status, metadata)
       VALUES ($1, $2, 'blob', $3, 'text/markdown', $4, 'clean', jsonb_build_object('storageKey', $5::text, 'blobId', $6::text))`,
      [resourceId, orgId, `blob:${record.sha256}`, record.sizeBytes, record.storageKey, record.blobId],
    );
    return resourceId;
  }

  /** Unique per seed: the resource table dedupes on the substance key, so two
   *  artifacts seeded with byte-identical text would share one resource row. */
  const pinnedTextFor = (marker: string) =>
    `# The pinned draft ${marker}\n\nThe paragraph a reviewer decides on.\n`;

  async function seedReviewableArtifact() {
    const artifactId = nextId("art");
    const revisionId = nextId("rev");
    const PINNED_TEXT = pinnedTextFor(revisionId);
    await sql(
      `INSERT INTO "${S()}"."objects" (id, org_id, type, data)
       VALUES ($1, $2, $3, jsonb_build_object('mime', 'text/markdown', 'artifactType', 'file'))`,
      [artifactId, ORG, GENERIC_ARTIFACT_TYPE],
    );
    const resourceId = await seedRealResource(ORG, artifactId, revisionId, PINNED_TEXT);
    await sql(
      `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form)
       VALUES ($1, $2, $3, $4, 1, 'file')`,
      [revisionId, ORG, artifactId, resourceId],
    );
    return { artifactId, revisionId, text: PINNED_TEXT };
  }

  /** The read road the review binder now takes for a pinned revision: the
   *  content channel's projection over the real text port. */
  const projectPinned = (artifactId: string, revisionId: string, mime = "text/markdown") =>
    channel.buildArtifactContentProjection(
      { orgId: ORG, artifactId, representationRevisionId: revisionId, form: "file", mime },
      pinnedText.artifactTextChannelPorts,
    );

  it("the projection carries the revision's TEXT — not a named absence", async () => {
    const seeded = await seedReviewableArtifact();

    expect(await projectPinned(seeded.artifactId, seeded.revisionId)).toMatchObject({
      kind: "text",
      representationRevisionId: seeded.revisionId,
      text: seeded.text,
      truncated: false,
    });
  });

  it("keeps the PINNED revision's text after the artifact has moved on twice", async () => {
    const seeded = await seedReviewableArtifact();
    let base = seeded.revisionId;
    const later = [`# Second ${seeded.revisionId}\n`, `# Third ${seeded.revisionId}\n`];
    for (const text of later) {
      const revisionId = nextId("rev");
      const resourceId = await seedRealResource(ORG, seeded.artifactId, revisionId, text);
      const appended = await store.appendRepresentationWithExpectedBase({
        orgId: ORG,
        artifactId: seeded.artifactId,
        baseRevisionId: base,
        resourceId,
        form: "file",
        createdBy: "user-1",
      });
      if (appended.kind !== "appended") throw new Error(`append was ${appended.kind}`);
      base = appended.record.id;
    }

    // The EDITOR opens on the head; the CARD stays on the revision the gate pinned.
    expect(store.resolveEditorRevisionId(ORG, seeded.artifactId, seeded.revisionId)).toBe(base);
    expect(await projectPinned(seeded.artifactId, seeded.revisionId)).toMatchObject({
      kind: "text",
      text: seeded.text,
    });
    expect(await projectPinned(seeded.artifactId, base)).toMatchObject({
      kind: "text",
      text: later[1],
    });
  });

  it("a revision whose class this port does not carry says so BY NAME, never as an empty document", async () => {
    const seeded = await seedReviewableArtifact();

    expect(await projectPinned(seeded.artifactId, seeded.revisionId, "image/png")).toMatchObject({
      kind: "none",
      reason: "unsupported-form",
    });
  });

  it("never crosses organizations — another org cannot project this revision", async () => {
    const seeded = await seedReviewableArtifact();

    expect(
      await channel.buildArtifactContentProjection(
        {
          orgId: OTHER_ORG,
          artifactId: seeded.artifactId,
          representationRevisionId: seeded.revisionId,
          form: "file",
          mime: "text/markdown",
        },
        pinnedText.artifactTextChannelPorts,
      ),
    ).toMatchObject({ kind: "none" });
  });
});
