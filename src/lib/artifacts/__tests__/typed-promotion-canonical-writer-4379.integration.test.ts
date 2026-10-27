/**
 * cinatra#4379 — THE TYPED PROMOTION THROUGH THE REAL CANONICAL WRITER, against
 * a REAL Postgres, on the real substrate DDL.
 *
 * When a person confirms a file's type, the road retypes the row through the
 * canonical history-aware objects writer and then appends a "promoted" revision.
 * The two writes are two transactions. If the call is interrupted between them,
 * the next confirmation must finish it exactly once; a confirmation on a row
 * that was never retyped by a promotion must append nothing. The decision rests
 * on one stored fact: the retype's change event carries the promotion's key
 * (`typed-promotion:<revision id>:<base version>`), and the store's proof read
 * accepts only that event (`typed-promotion-store.ts`, cinatra#3319 and
 * cinatra#4266).
 *
 * The #3028 tier substitutes the writer's compare-and-set with a stand-in that
 * records the key, and the unit tier (the CANON case of
 * `typed-promotion-proof-3319.test.ts`) pins that the production retype hands
 * the key to the writer, with a substituted store. THIS file runs the step in
 * between with nothing substituted on the write side: the real writer stores
 * the real change-event row, and the real proof read accepts or refuses it.
 *
 * ITS CONFIG (`vitest/integration/4379.config.ts`) provisions the boot graph the
 * writer loads by reusing the root config's alias list. Only two modules are
 * replaced here: the database facade (bound to the isolated schema) and the
 * from-scratch schema bootstrap (the schema is built below from the canonical
 * DDL), as the #1381 real-writer suite does.
 *
 * ISOLATION: a schema and an organization row of THIS RUN'S OWN (a random name
 * per run; setup refuses a name that exists and teardown removes only what the
 * run created), the schema built from the CANONICAL
 * `buildCreateStoreSchemaQueries` DDL — never hand-rolled DDL, so every
 * constraint is the production one. That DDL runs with the search path set to
 * the run's schema only; a statement that names `public` (the slug columns,
 * indexes and triggers on the Better Auth tables) is left out, and one that
 * names any other schema of the database fails the setup. The tier creates
 * nothing in public: the Better Auth tables the DDL names must already exist
 * (scripts/apply-public-schema.mjs, as CI provisions them). Because `postgresSchema` is a module-load
 * const, every app module is dynamically imported in `beforeAll` AFTER the env
 * is set.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

// The root alias list maps `@/lib/database` to an inert stub (its connection
// string is a placeholder). Keep every export the stub gives the boot graph,
// and bind the four this suite must control to the isolated schema.
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const cfg = await import("@/lib/postgres-config");
  return {
    ...actual,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
// The schema is provisioned below from the canonical DDL builder.
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);

// THE LOUD FAILURE AT MODULE SCOPE, not in a hook: `describe.skipIf` skips every
// suite in the file, and a file with nothing left to run never runs its
// file-level hooks — a tier whose only failure mode is "skipped" reports success
// by doing nothing.
if (process.env.CINATRA_TYPED_PROMOTION_WRITER_REALDB === "1" && !HAS_REAL_DB) {
  throw new Error(
    "this tier exists to run against a real Postgres, and it was asked to run: " +
      "set SUPABASE_DB_URL to a scratch database that already holds the Better Auth " +
      "public tables (apply them with scripts/apply-public-schema.mjs, as the CI job " +
      "does). The tier creates and drops only its own schema and its own " +
      "organization row there, and creates nothing in public.",
  );
}

// A per-run random tag (lowercase hex, so it is a plain identifier) plus a counter:
// unique without the wall clock, so two runs against one database never mint the
// same schema, organization or object id.
const RUN = randomUUID().replaceAll("-", "").slice(0, 12);
// THIS RUN'S OWN schema and organization. Two runs of this tier against one
// database (two CI jobs, a re-run, a lane) never share either: setup creates them
// fresh and refuses a name that already exists, and teardown removes only what
// this run created. A fixed name let one run drop another run's live schema.
const TEST_SCHEMA = `cinatra_test_tpw4379_${RUN}`;
const ORG = `org-4379-${RUN}`;
const EXT = "@cinatra-ai/campaigns-artifact";
const BASE_TYPE = "@cinatra-ai/text-artifact:text";
const OWN_TYPE = "@cinatra-ai/campaigns:voice";
const USER = "user-4379";

let uniq = 0;
const nextId = (p: string) => `${p}-${RUN}-${uniq++}`;

let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let promotionStore: typeof import("@/lib/artifacts/typed-promotion-store");
let promotionMod: typeof import("@/lib/artifacts/typed-promotion");
let writerMod: typeof import("@/lib/object-history/canonical-writer");

/** The acting principal the retype's history event records. */
const ACTOR = { userId: USER, orgId: ORG };
/**
 * The org-write kernel authority the canonical writer hands to the guarded
 * batch. Minted host-side in production (`verifySessionAuthority`, which reads
 * the Better Auth membership tables); the kernel asks it only for its
 * organization and for each capability, so the fixture answers both directly.
 * The kernel's in-SQL lifecycle ruling still reads the real organization row
 * seeded below.
 */
const AUTHORITY = { orgId: ORG, can: () => true } as never;

const S = () => TEST_SCHEMA;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** The key a promotion's own retype records (`promotionRetypeKey` in the store). */
function promotionKey(objectId: string, resourceId: string, toType: string, base: number) {
  const revisionId = promotionMod.promotionRevisionId({
    artifactId: objectId,
    sharedResourceId: resourceId,
    toType,
  });
  return `typed-promotion:${revisionId}:${base}`;
}

/** Seed a base-typed row at version 1 with ONE content revision over a real resource. */
function seedRepresentedRow(objectId: string) {
  const resourceId = nextId("res");
  const blobId = nextId("blob");
  sql(
    `INSERT INTO "${S()}"."objects"
       (id, type, org_id, data, version, graphiti_sync_status, owner_level, owner_id, visibility, deleted_at)
     VALUES ($1,$2,$3,$4::jsonb,1,'pending','organization',$3,'organization',NULL)`,
    [objectId, BASE_TYPE, ORG, JSON.stringify({ title: "an upload" })],
  );
  sql(
    `INSERT INTO "${S()}"."resource" (id, org_id, kind, substance_key, mime, size_bytes, created_by, metadata)
     VALUES ($1,$2,'blob',$3,'text/markdown',10,NULL, jsonb_build_object('storageKey','k','blobId',$4::text))`,
    [resourceId, ORG, nextId("sub"), blobId],
  );
  sql(
    `INSERT INTO "${S()}"."artifact_blobs"
       (id, org_id, storage_backend, storage_key, sha256, size_bytes, mime_detected, created_by)
     VALUES ($1,$2,'local-disk',$3,$4,10,'text/markdown',NULL)`,
    [blobId, ORG, nextId("key"), nextId("sha")],
  );
  sql(
    `INSERT INTO "${S()}"."representation" (id, org_id, artifact_id, resource_id, revision, form, created_by)
     VALUES ($1,$2,$3,$4,1,'file',NULL)`,
    [nextId("rev"), ORG, objectId, resourceId],
  );
  // The matcher's association that backs the confirmation (threshold 0.8).
  sql(
    `INSERT INTO "${S()}"."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility, confidence)
     VALUES ($1,$2,$3,$4,'matcher','draft',0.9)`,
    [nextId("assert"), ORG, objectId, EXT],
  );
  return { resourceId };
}

function confirmation(objectId: string) {
  return {
    orgId: ORG,
    artifactId: objectId,
    extension: EXT,
    ownType: { typeId: OWN_TYPE, acceptsMimes: ["text/markdown"] },
    threshold: 0.8,
    confirmed: true,
    createdBy: USER,
    actor: ACTOR,
    authority: AUTHORITY,
    // NO `retype`: the road takes its production retype, the canonical writer.
  };
}

/** The real writer's own retype of the row, outside the promotion road. */
function writerRetype(objectId: string, idempotencyKey: string | undefined) {
  writerMod.historyAwareUpsert(
    { id: objectId, type: OWN_TYPE, data: { title: "an upload" }, orgId: ORG },
    {
      actor: { actorId: USER, actorKind: "user", orgId: ORG },
      historyEffect: "reversible-internal",
      expectedBaseVersion: 1,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      authority: AUTHORITY,
    },
  );
}

function typeChangeEventsOf(objectId: string) {
  return (sql(
    `SELECT idempotency_key, base_version, result_version, object_type,
            before_snapshot->>'type' AS before_type
     FROM "${S()}"."object_change_event"
     WHERE object_id = $1 AND org_id = $2
       AND (before_snapshot->>'type') IS DISTINCT FROM object_type
     ORDER BY result_version ASC`,
    [objectId, ORG],
  ).rows ?? []) as Array<{
    idempotency_key: string;
    base_version: number;
    result_version: number;
    object_type: string;
    before_type: string | null;
  }>;
}

function representationsOf(objectId: string) {
  return (sql(
    `SELECT id, resource_id, revision FROM "${S()}"."representation"
     WHERE org_id=$1 AND artifact_id=$2 ORDER BY revision ASC`,
    [ORG, objectId],
  ).rows ?? []) as Array<{ id: string; resource_id: string; revision: number }>;
}

function rowOf(objectId: string) {
  return sql(`SELECT type, version FROM "${S()}"."objects" WHERE id=$1 AND org_id=$2`, [
    objectId,
    ORG,
  ]).rows[0] as { type: string; version: number };
}

/** What THIS run created, so teardown removes exactly that and nothing else. */
const owned = { schema: false, org: false };

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One cleanup step on a connection of its OWN, so a failed connect, query or
 * close of one step never keeps the next step from being tried. Every failure
 * is pushed to `errors`; the result says whether the statement ran.
 */
async function cleanupStep(label: string, sql: string, params: unknown[], errors: Error[]): Promise<boolean> {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
  } catch (err) {
    errors.push(new Error(`${label}: connect failed: ${errText(err)}`));
    return false;
  }
  let ran = false;
  try {
    await client.query(sql, params);
    ran = true;
  } catch (err) {
    errors.push(new Error(`${label}: ${errText(err)}`));
  }
  try {
    await client.end();
  } catch (err) {
    errors.push(new Error(`${label}: close failed: ${errText(err)}`));
  }
  return ran;
}

/**
 * Remove what this run created. EVERY step is tried, whatever an earlier step
 * did (each on its own connection), and every failure — a connect, a statement
 * or a close — is collected and thrown together: a teardown that swallowed one
 * would report green while leaving state behind. Idempotent (a step that ran is
 * not repeated), so setup's own failure path and `afterAll` can both call it.
 */
async function cleanUpOwned(): Promise<void> {
  const errors: Error[] = [];
  if (owned.schema && (await cleanupStep(`drop schema ${TEST_SCHEMA}`, `DROP SCHEMA "${TEST_SCHEMA}" CASCADE`, [], errors))) {
    owned.schema = false;
  }
  if (owned.org && (await cleanupStep(`delete organization ${ORG}`, `DELETE FROM public."organization" WHERE id = $1`, [ORG], errors))) {
    owned.org = false;
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `cinatra#4379 teardown failed in ${errors.length} step(s); left behind: ` +
        `${owned.schema ? `schema ${TEST_SCHEMA} ` : ""}${owned.org ? `organization ${ORG}` : ""}`.trim() +
        `: ${errors.map((e) => e.message).join(" | ")}`,
    );
  }
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Whether SQL text names `schema` as a qualifier (`schema.x` or `"schema".x`).
 * A qualifier never follows a dot, slash, colon, `@` or hyphen, so a host name
 * such as `registry.<schema>.ai` inside a literal does not count.
 */
const namesSchema = (text: string, schema: string): boolean =>
  new RegExp(`(^|[^\\w$".\\/:@-])"?${escapeRe(schema)}"?\\s*\\.`, "i").test(text);

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  // MUST precede every app-module import (module-load schema const).
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    const canonical = buildCreateStoreSchemaQueries(TEST_SCHEMA);

    // The tier creates nothing in public. It reads the Better Auth tables the CI
    // job (and any lane) provisions with scripts/apply-public-schema.mjs, and
    // the organization-write kernel reads `public."organization"`: every public
    // table the canonical DDL names must already exist, or nothing is created.
    const publicTables = [
      ...new Set([
        "organization",
        ...canonical.flatMap((q) => [...q.text.matchAll(/\bpublic\."([A-Za-z_][A-Za-z0-9_]*)"/g)].map((m) => m[1])),
      ]),
    ].sort();
    const missing: string[] = [];
    for (const table of publicTables) {
      const found = await client.query(`SELECT to_regclass($1) AS t`, [`public."${table}"`]);
      if (!(found.rows[0] as { t: string | null }).t) missing.push(`public."${table}"`);
    }
    if (missing.length > 0) {
      throw new Error(
        `this tier needs the Better Auth tables ${missing.join(", ")}: provision them with ` +
          "scripts/apply-public-schema.mjs (the CI job does) before running the tier",
      );
    }
    // Every other schema of this database is out of bounds for the DDL (another
    // run's schema, the application's own): a statement naming one fails setup.
    const others = (
      await client.query(
        `SELECT nspname FROM pg_namespace
          WHERE nspname NOT IN ('public', 'information_schema') AND nspname NOT LIKE 'pg\\_%'`,
      )
    ).rows
      .map((r) => (r as { nspname: string }).nspname)
      .filter((n) => n !== TEST_SCHEMA);

    // NEVER a drop here: this run's schema is new. Without IF NOT EXISTS the
    // CREATE itself refuses a name that already exists, so setup can never adopt
    // or destroy a schema another run (or anyone) owns.
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    owned.schema = true;
    // Unqualified names resolve to this run's schema only (pg_catalog is always
    // searched first, for the built-in types and functions).
    await client.query(`SET search_path TO "${TEST_SCHEMA}"`);
    let ran = 0;
    const leftOut: string[] = [];
    for (const qy of canonical) {
      const head = qy.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
      const other = others.find((n) => namesSchema(qy.text, n));
      if (other !== undefined) {
        throw new Error(
          `cinatra#4379 setup refused a canonical statement that names schema "${other}" ` +
            `(the tier runs DDL on its own schema only): ${qy.text.trim().split("\n")[0]}`,
        );
      }
      // The slug columns, indexes and triggers on the Better Auth tables: shared
      // objects of every run and of the application. Never run here.
      if (namesSchema(qy.text, "public")) {
        leftOut.push(qy.text.trim().split("\n")[0]);
        continue;
      }
      try {
        await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
        ran++;
      } catch (err) {
        if (!errText(err).includes("does not exist")) throw err;
      }
    }
    console.info(
      `cinatra#4379 setup: ${ran} canonical DDL statements ran in ${TEST_SCHEMA}; ` +
        `${leftOut.length} left out because they name public: ${leftOut.join(" | ")}`,
    );
    // This run's own row: no ON CONFLICT, so a row that already exists is refused,
    // never adopted and later deleted.
    await client.query(
      `INSERT INTO public."organization" (id, name, slug, "archivedAt", "archiveEpoch", "createdAt")
       VALUES ($1, 'Typed promotion writer 4379', $2, NULL, 0, now())`,
      [ORG, `typed-promotion-writer-4379-${RUN}`],
    );
    owned.org = true;
  } catch (err) {
    // Setup failed part-way: close this client and remove what setup already
    // created, and report every failure, never only the first.
    const failures: unknown[] = [err];
    try {
      await client.end();
    } catch (closeErr) {
      failures.push(closeErr);
    }
    try {
      await cleanUpOwned();
    } catch (cleanupErr) {
      failures.push(cleanupErr);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `cinatra#4379 setup failed, and so did ${failures.length - 1} of its cleanup step(s): ` +
          failures.map(errText).join(" | "),
      );
    }
    throw err;
  }
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  promotionMod = await import("@/lib/artifacts/typed-promotion");
  promotionStore = await import("@/lib/artifacts/typed-promotion-store");
  writerMod = await import("@/lib/object-history/canonical-writer");
}, 120_000);

// On every exit road the runner reaches (cases passed, failed or skipped after a
// failed setup) this removes what the run created, and fails loudly if it cannot.
// A killed process runs no hook at all; its leftovers carry this run's own random
// name (48 random bits). A later run that drew the same name would be refused at
// CREATE SCHEMA or at its organization insert; it would never adopt them.
afterAll(async () => {
  if (!HAS_REAL_DB) return;
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
  await cleanUpOwned();
});

describe.skipIf(!HAS_REAL_DB)("cinatra#4379 — the canonical writer's keyed retype is the promotion's proof (real DB)", () => {
  it("PROMOTES through the real writer: its event carries the key and the anchored base, the proof read accepts it, and a repeat appends nothing", async () => {
    const objectId = nextId("obj-fresh");
    const { resourceId } = seedRepresentedRow(objectId);

    const out = await promotionStore.promoteMatchedArtifactType(confirmation(objectId));
    // The append runs only when the proof read accepts the row's latest type
    // change; `promotion-unproven` here would mean it refused the writer's event.
    expect(out).toMatchObject({ ok: true, retyped: true, toType: OWN_TYPE, revision: 2 });

    // THE STORED FACT: the real writer's change event for the retype carries the
    // promotion's key, anchored on the version the compare-and-set read.
    expect(rowOf(objectId)).toEqual({ type: OWN_TYPE, version: 2 });
    expect(typeChangeEventsOf(objectId)).toEqual([
      {
        idempotency_key: promotionKey(objectId, resourceId, OWN_TYPE, 1),
        base_version: 1,
        result_version: 2,
        object_type: OWN_TYPE,
        before_type: BASE_TYPE,
      },
    ]);

    // EXACTLY ONE promotion revision, sharing the base revision's resource.
    const after = representationsOf(objectId);
    expect(after.map((r) => r.revision)).toEqual([1, 2]);
    expect(after[1]!.resource_id).toBe(resourceId);
    expect(after[1]!.id).toBe(
      promotionMod.promotionRevisionId({
        artifactId: objectId,
        sharedResourceId: resourceId,
        toType: OWN_TYPE,
      }),
    );

    // A REPEATED CONFIRMATION answers already-promoted and appends nothing: it
    // reaches the converging branch, whose deterministic append finds the
    // promotion's own revision already in place, so there is nothing to complete.
    expect(await promotionStore.promoteMatchedArtifactType(confirmation(objectId))).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(representationsOf(objectId)).toEqual(after);
    expect(rowOf(objectId)).toEqual({ type: OWN_TYPE, version: 2 });
  });

  it("COMPLETES an interrupted promotion exactly once: the real writer stored the keyed retype, the append never ran", async () => {
    const objectId = nextId("obj-interrupted");
    const { resourceId } = seedRepresentedRow(objectId);

    // THE INTERRUPTION: the promotion's retype committed through the real writer
    // with the promotion's key, and the call stopped before its append.
    writerRetype(objectId, promotionKey(objectId, resourceId, OWN_TYPE, 1));
    expect(rowOf(objectId)).toEqual({ type: OWN_TYPE, version: 2 });
    expect(representationsOf(objectId)).toHaveLength(1);

    // The next confirmation reaches the converging branch; the proof read accepts
    // the writer's stored event, and the missing revision is appended once.
    const out = await promotionStore.promoteMatchedArtifactType(confirmation(objectId));
    expect(out).toMatchObject({ ok: true, retyped: false, toType: OWN_TYPE, revision: 2 });
    const after = representationsOf(objectId);
    expect(after.map((r) => r.revision)).toEqual([1, 2]);
    expect(after[1]!.resource_id).toBe(resourceId);

    // A third confirmation has nothing left to complete.
    expect(await promotionStore.promoteMatchedArtifactType(confirmation(objectId))).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(representationsOf(objectId)).toEqual(after);
  });

  it("APPENDS NOTHING on a row the real writer retyped without the promotion's key", async () => {
    const objectId = nextId("obj-unkeyed");
    seedRepresentedRow(objectId);

    // Another writer of a type change (a restore, a merge): the real writer
    // records its own generated key, so the event is no promotion's proof.
    writerRetype(objectId, undefined);
    const events = typeChangeEventsOf(objectId);
    expect(events).toHaveLength(1);
    expect(events[0]!.idempotency_key.startsWith("typed-promotion:")).toBe(false);
    expect(events[0]!.base_version).toBe(1);

    expect(await promotionStore.promoteMatchedArtifactType(confirmation(objectId))).toEqual({
      ok: false,
      reason: "already-promoted",
    });
    expect(representationsOf(objectId)).toHaveLength(1);
    expect(rowOf(objectId)).toEqual({ type: OWN_TYPE, version: 2 });
  });
});
