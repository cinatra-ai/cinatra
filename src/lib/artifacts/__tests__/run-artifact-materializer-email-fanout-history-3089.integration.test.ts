/**
 * cinatra#3089 acceptance item 5 — the email fan-out's cutover is forward-only,
 * proved against a REAL Postgres:
 *
 *   5. "A fixture database's historical raw rows and associations are
 *      byte-identical before and after — no backfill."
 *
 * The unit suite beside this file (`run-artifact-materializer-email-fanout-3089
 * .test.ts`) proves what the fan-out DECIDES against substituted ports. What
 * only a database can show is what the fan-out leaves alone: a stubbed store
 * cannot rewrite a row, so it cannot prove that no row was rewritten.
 *
 * THE FIXTURE is the database a send that straddled the cutover leaves behind,
 * written before the fan-out runs:
 *   - the raw `email:body` rows the send boundary wrote before the cutover —
 *     one objects row per draft item, keyed by the SAME message identity the
 *     ledgered fan-out now uses, carrying the raw payload of that time (`body`,
 *     `draftItemId`, `step`, no `bodyMarkdown`, no representation, no ledger
 *     row) — for the send under test and for an older send;
 *   - the raw `email:recipient` rows the boundary wrote beside them, one per
 *     confirmed recipient of the send under test and one of the older send;
 *   - the associations on those rows: the producer's eligible assertion, an
 *     archived one, and a matcher's un-promoted draft association on a
 *     base-type row;
 *   - one body an earlier run's producer binding filed through the ledger, over
 *     the SAME bytes as one draft of the send, so the fan-out's write reaches a
 *     content-addressed resource row that already exists.
 *
 * THE PRODUCER STATE is valid: the run's template names its agent package and
 * the run pins its version, and that package's manifest declares the body type
 * under `cinatra.produces`. The producer chain therefore validates the run and
 * files the agent's association on each new body, as it does in production;
 * nothing degrades to "no producer assertion".
 *
 * THE DRIVE is the production fan-out: `materializeEmailFanout` with its body
 * writer wired to the real `materializeFanoutMessageRevision`, exactly as the
 * send boundary's default projection wires it, over the send's drafts AND its
 * confirmed recipients (the boundary passes both), run TWICE over the same send.
 *
 * THE CLAIM is read as bytes: before the first drive, every relation of the
 * schema is listed with its kind, and every row of every ordinary table is read
 * in its text form, column by column; after both drives every one of those rows
 * must still be there, unchanged. An index or a sequence counts as shape only;
 * a relation of any other kind (partitioned, foreign, a view) holds rows this
 * tier does not read, so a reading that meets one fails instead of calling the
 * schema unchanged. Neither drive may change the schema's shape: its relations,
 * their kinds and the ordinary tables' columns. What the first drive
 * ADDS is held to an exact permitted delta: per table, exactly the rows of the
 * send's new bodies (their objects, representation, audit, association, outbox
 * and ledger rows, and the one new content-addressed resource and blob), in an
 * exact count, and nothing else — so an additive backfill (a copy of a raw row
 * under a new id, an association or revision added to a historical row) fails
 * as surely as a rewrite. The historical rows and their associations are then
 * read again by name, so a failure says which row moved and how.
 *
 * NOT A STUB ANYWHERE THAT MATTERS. The fan-out, the ledger, the claim
 * arbitration, the producer chain and its association writes, the type
 * resolution, the creation path and the blob store are the production ones.
 * Substituted, as the sibling real-DB tiers substitute them: the schema and
 * connection seams the throwaway schema needs, the app-boot type registrar
 * (this suite registers the one type it needs), the meaning matcher's
 * post-commit queue enqueue, which writes no row, and the package registry's
 * network read: `getAgentPackage` answers the fixture package's manifest (and
 * refuses any other), the registry config loader a fixed config.
 *
 * CLIENTS AND TEARDOWN. Each client the tier opens (setup, reader, teardown) is
 * built, connected and closed under one failure-collecting road: a malformed
 * setting (the pg constructor parses the URL at once), a refused connection, a
 * failed body or a failed close each fail the run, and a client that was built
 * is closed whatever failed after it. Each client reads the application name
 * of its session after the connect, and a session that carries another name
 * (a URL's own `application_name` wins over the Client option) fails the run:
 * the teardown finds the tier's sessions by that name. The teardown runs every
 * step (schema drop, a check that no session of the tier is left open, blob
 * root, process state) whatever fails, and then fails the run naming each step
 * that failed: a tier that cannot drop its schema, or that leaves a session
 * open, does not finish green.
 *
 * ISOLATION (the #3030 / #3032 pattern): a fresh schema from the CANONICAL
 * `buildCreateStoreSchemaQueries` DDL; the artifact blob root is a temp dir;
 * every app module is imported in `beforeAll` after the env is set, because
 * `postgresSchema` is a module-load const.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

// PARTIAL mock, the #3030 posture: only the schema/connection the throwaway
// schema needs and the metadata reads the data root consults are substituted;
// everything else in the write path stays real.
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
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
// This suite registers the exact type it needs directly; the app-boot registrar
// must not clobber it.
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));
// The meaning matcher is a post-commit best-effort enqueue onto a queue this
// tier does not run. It writes no database row, so it cannot touch the claim.
vi.mock("@/lib/artifacts/matcher-enqueue", () => ({
  enqueueArtifactMatchRun: async () => {},
}));

// THE PRODUCER DECLARATION: the agent package the fixture's template names, at
// the version the runs pin, declares the body type. Only the registry's network
// read is substituted; the producer chain that reads it (run validation, the
// template's package, the manifest's `produces`, the install-active write gate)
// is the production one.
const producer = vi.hoisted(() => {
  const packageName = "@cinatra-ai/outreach-fixture-agent";
  const packageVersion = "1.0.0";
  const config = { registryUrl: "http://registry.invalid/", fixture: "3089" };
  const manifest = {
    name: packageName,
    version: packageVersion,
    cinatra: {
      packageType: "agent",
      manifestVersion: 1,
      sourceTemplateId: "tpl-3089",
      sourceVersionId: "v1",
      sourceVersionNumber: 1,
      riskLevel: "low",
      hasApprovalGates: false,
      toolAccess: [],
      ownerOrgId: null,
      produces: [{ extension: "@cinatra-ai/email-artifacts", objectTypeId: "@cinatra-ai/email:body" }],
    },
  };
  const reads: Array<{ packageName: string; packageVersion: string | undefined; configOk: boolean }> = [];
  return { packageName, packageVersion, config, manifest, reads };
});
vi.mock("@cinatra-ai/registries", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getAgentPackage: async (
      input: { packageName: string; packageVersion?: string },
      config?: unknown,
    ) => {
      producer.reads.push({
        packageName: input.packageName,
        packageVersion: input.packageVersion,
        configOk: config === producer.config,
      });
      if (input.packageName !== producer.packageName || input.packageVersion !== producer.packageVersion) {
        throw new Error(`no package ${input.packageName}@${input.packageVersion ?? "(default)"} in the fixture registry`);
      }
      return { manifest: producer.manifest };
    },
  };
});
vi.mock("@/lib/verdaccio-config", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, loadVerdaccioConfigForReads: async () => producer.config };
});

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);

// THE LOUD FAILURE AT MODULE SCOPE (the #3030 rule): a tier whose only failure
// mode is "skipped" reports success by doing nothing.
if (process.env.CINATRA_EMAIL_FANOUT_HISTORY_REALDB === "1" && !HAS_REAL_DB) {
  throw new Error(
    "this tier exists to run against a real Postgres, and it was asked to run: " +
      "set SUPABASE_DB_URL to a scratch database. It builds and drops its own " +
      "schema, so any throwaway database will do.",
  );
}

const TEST_SCHEMA = "cinatra_test_email_fanout_history_3089";
const ORG = "org-3089";
const TEMPLATE = "tpl-3089";
const USER = "user-3089";
const CAMPAIGN = "campaign-3089";
/** The send under test: its bodies were first filed as raw rows. */
const RUN_SEND = "run-3089-send";
/** An older send, wholly from before the cutover. */
const RUN_OLD = "run-3089-old";

/** The pack whose claim wins the body type, and the body type it declares. */
const EMAIL_EXT = "@cinatra-ai/email-artifacts";
const BODY_TYPE = "@cinatra-ai/email:body";
const RECIPIENT_TYPE = "@cinatra-ai/email:recipient";
/** A base type a matcher associated with the email pack without retyping it. */
const BASE_TYPE = "@cinatra-ai/text-artifact:document";

/** Before the cutover (the fan-out moved onto the ledger on 2026-09-28). */
const BEFORE_CUTOVER = "2026-09-20T10:00:00.000Z";

const BODY_ONE = "# Hello One\n\nThe first draft of the send, as the drafting step wrote it.\n";
const BODY_TWO = "# Hello Two\n\nThe second draft of the send, as the drafting step wrote it.\n";
const BODY_OLD = "# An older hello\n\nA draft of a send from before the cutover.\n";

const DRAFTS = [
  { id: "d1", contactId: "contact-1", subject: "Hello One", body: BODY_ONE, step: 1 },
  { id: "d2", contactId: "contact-2", subject: "Hello Two", body: BODY_TWO, step: 1 },
];

/** The send's confirmed recipients: what the boundary reads from the
 *  confirmed-recipients bundle and passes to the fan-out beside the drafts.
 *  Each one also has the raw `email:recipient` row the boundary wrote. */
const SEND_RECIPIENTS = [
  { rowId: "hist-recipient-send-1", contactId: "contact-1", email: "one@example.test", name: "One" },
  { rowId: "hist-recipient-send-2", contactId: "contact-2", email: "two@example.test", name: "Two" },
];

/** The historical rows, by name: what the cutover must leave alone. */
const HISTORICAL_OBJECT_IDS = [
  "hist-body-send-d1",
  "hist-body-send-d2",
  "hist-body-old-d1",
  "hist-recipient-send-1",
  "hist-recipient-send-2",
  "hist-recipient-old-1",
  "hist-base-document-1",
];
const HISTORICAL_BODY_IDS = ["hist-body-send-d1", "hist-body-send-d2", "hist-body-old-d1"];
const HISTORICAL_ASSERTION_IDS = [
  "hist-sa-send-d1",
  "hist-sa-send-d2",
  "hist-sa-old-d1",
  "hist-sa-old-d1-archived",
  "hist-sa-base-matcher",
];

let BLOB_ROOT = "";

let runPostgresQueriesAsync: typeof import("@/lib/postgres-async").runPostgresQueriesAsync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;
let materializer: typeof import("@/lib/artifacts/run-artifact-materializer");
let fanout: typeof import("@/lib/trigger-email-send-use-cases");

const S = () => TEST_SCHEMA;
const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

async function sql(text: string, values: unknown[] = []) {
  const [res] = await runPostgresQueriesAsync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  });
  return res;
}

// ---------------------------------------------------------------------------
// The tier's own clients: built, connected and closed on one road.
// ---------------------------------------------------------------------------

/** What the tier needs of a client: the pg Client, or a stand-in in the
 *  in-file tests of this road. */
type TierClient = {
  connect(): Promise<unknown>;
  query(text: string): Promise<{ rows: unknown[] }>;
  end(): Promise<unknown>;
};

/** Every client the tier opens carries this name, so the teardown can find a
 *  session of the tier that was left open. The production write path's pools
 *  do not carry it. */
const TIER_APPLICATION_NAME = "cinatra-3089-history-tier";

/** A client on the tier's database. The pg constructor parses the URL at once,
 *  so a malformed setting throws here, inside the road below. The name given
 *  here is only asked for: the road below reads the name the session has. */
const newTierClient = () => new Client({ connectionString: DB_URL, application_name: TIER_APPLICATION_NAME });

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Why a client whose session carries another name is refused. The message
 *  never repeats that name: it comes from the URL or the server. */
const NAME_REFUSED =
  `the session's application_name is not ${TIER_APPLICATION_NAME} (the connection string or the server ` +
  "set another), so the teardown could not find a session of the tier that was left open";

/**
 * Build and connect one client, then read the application name of its session.
 * A build failure leaves nothing to close; a client that was built and failed
 * after that is closed here, and the call fails naming the failed stage and any
 * failed close.
 *
 * The name is read from the session, not trusted from the option: pg merges
 * the connection string's own parameters over the Client options, so a URL
 * with an `application_name` of its own gives every session of the tier that
 * name instead. The teardown counts the sessions left open by the tier's name,
 * and would then count none, whatever was left open.
 */
async function openTierClient<C extends TierClient>(label: string, open: () => C): Promise<C> {
  let client: C | undefined;
  let stage = "build";
  try {
    client = open();
    stage = "connect";
    await client.connect();
    stage = "name";
    const res = await client.query("SHOW application_name");
    const name = (res.rows[0] as { application_name?: unknown } | undefined)?.application_name;
    if (name !== TIER_APPLICATION_NAME) throw new Error(NAME_REFUSED);
    return client;
  } catch (err) {
    const failed = [`${stage}: ${message(err)}`];
    if (client !== undefined) {
      try {
        await client.end();
      } catch (closeErr) {
        failed.push(`close: ${message(closeErr)}`);
      }
    }
    throw new Error(`the ${label} client failed (${failed.join("; ")})`);
  }
}

/**
 * Run `body` on a client opened as above, then close it whatever the body did.
 * The call fails naming every failed stage: the build, the connect, the body
 * and the close.
 */
async function withTierClient<C extends TierClient, T>(
  label: string,
  open: () => C,
  body: (client: C) => Promise<T>,
): Promise<T> {
  const client = await openTierClient(label, open);
  const failed: string[] = [];
  let out: T | undefined;
  try {
    out = await body(client);
  } catch (err) {
    failed.push(`run: ${message(err)}`);
  }
  try {
    await client.end();
  } catch (err) {
    failed.push(`close: ${message(err)}`);
  }
  if (failed.length > 0) throw new Error(`the ${label} client failed (${failed.join("; ")})`);
  return out as T;
}

/** The sessions of the tier still open on its database, other than the
 *  asking one. A closed client's backend ends a moment after the close, so the
 *  count is read again for up to five seconds before a session is called left
 *  open. */
async function tierSessionsLeft(client: Client): Promise<number> {
  let left = 0;
  for (let i = 0; i < 50; i += 1) {
    const res = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()`,
      [TIER_APPLICATION_NAME],
    );
    left = Number(res.rows[0]?.n ?? 0);
    if (left === 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return left;
}

// ---------------------------------------------------------------------------
// The byte reading: every relation of the schema by its kind, and every row of
// every ordinary table, as text.
// ---------------------------------------------------------------------------

type TableRows = { columns: string[]; rows: string[] };
type Tables = Map<string, TableRows>;
/** One relation of the schema: its pg_class kind and, for an ordinary table,
 *  its live columns in table order. */
type Relation = { kind: string; columns: string[] };
type Snapshot = { shape: Map<string, Relation>; tables: Tables };

/**
 * How the tier reads a relation of its schema, by its `pg_class.relkind`. An
 * ordinary table's rows are read. An index or a sequence is shape only: its
 * name and kind. Every other kind (a partitioned or foreign table, a view, a
 * materialized view, a composite type, a partitioned index) holds or shows rows
 * this tier does not read, so a reading that meets one fails: it never calls a
 * relation unchanged that it did not read.
 */
const RELATION_ROLES: Readonly<Record<string, "rows" | "shape">> = { r: "rows", i: "shape", S: "shape" };
function relationRole(name: string, kind: string): "rows" | "shape" {
  const role = Object.hasOwn(RELATION_ROLES, kind) ? RELATION_ROLES[kind] : undefined;
  if (role === undefined) {
    throw new Error(
      `the schema holds ${name}, a relation of kind '${kind}' whose rows this tier does not read, ` +
        "so it refuses to call the schema unchanged",
    );
  }
  return role;
}

/** Every relation of the schema, by name: its kind, and an ordinary table's
 *  live columns. Fails on a relation of a kind the tier does not read. */
async function readShape(client: Client): Promise<Map<string, Relation>> {
  const rels = await client.query<{ name: string; kind: string }>(
    `SELECT c.relname AS name, c.relkind::text AS kind FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 ORDER BY c.relname`,
    [S()],
  );
  const shape = new Map<string, Relation>();
  for (const { name, kind } of rels.rows) {
    let columns: string[] = [];
    if (relationRole(name, kind) === "rows") {
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [S(), name],
      );
      columns = cols.rows.map((r) => r.column_name);
    }
    shape.set(name, { kind, columns });
  }
  return shape;
}

/**
 * Read the schema's shape and every ordinary table's rows. Each row is its
 * ROW(...) text form over the columns `columnsOf` read for that table (or the
 * table's own live columns, in table order, for a table `columnsOf` did not
 * read): the bytes Postgres renders for the stored values. Rows are sorted, so
 * two readings compare as multisets. ONE connection for every reading, so the
 * session settings that shape the text form (time zone, float digits) are the
 * same each time.
 */
async function snapshot(client: Client, columnsOf?: Snapshot): Promise<Snapshot> {
  const shape = await readShape(client);
  const tables: Tables = new Map();
  for (const [name, relation] of shape) {
    if (relationRole(name, relation.kind) !== "rows") continue;
    const columns = columnsOf?.tables.get(name)?.columns ?? relation.columns;
    const res = await client.query<{ r: string }>(
      `SELECT ROW(${columns.map(q).join(", ")})::text AS r FROM ${q(S())}.${q(name)}`,
    );
    tables.set(name, { columns, rows: res.rows.map((x) => x.r).sort() });
  }
  return { shape, tables };
}

/** The rows of `before` that are not in `after`, per table (multiset). */
function rowsGone(before: Tables, after: Tables): Record<string, string[]> {
  const gone: Record<string, string[]> = {};
  for (const [table, { rows }] of before) {
    const left = new Map<string, number>();
    for (const r of after.get(table)?.rows ?? []) left.set(r, (left.get(r) ?? 0) + 1);
    const missing: string[] = [];
    for (const r of rows) {
      const n = left.get(r) ?? 0;
      if (n > 0) left.set(r, n - 1);
      else missing.push(r);
    }
    if (missing.length > 0) gone[table] = missing;
  }
  return gone;
}

/** The rows of `after` that are not in `before`, per table (multiset). */
function rowsAdded(before: Tables, after: Tables): Record<string, string[]> {
  return rowsGone(after, before);
}

/**
 * THE FIRST DRIVE'S EXACT PERMITTED DELTA. Two new bodies (BODY_ONE's bytes
 * already have a content-addressed resource, BODY_TWO's do not), each written
 * by the production creation path: its objects row and projection outbox row,
 * its representation, its writer-witness audit row, its produced-event outbox
 * row, its finalized ledger row, and two associations (the producer's classic,
 * superseded in the same write by the claim's binding). Nothing else.
 */
const FIRST_DRIVE_DELTA: Record<string, number> = {
  artifact_audit: 2,
  artifact_blobs: 1,
  artifact_materializations: 2,
  artifact_produced_outbox: 2,
  graphiti_projection_outbox: 2,
  objects: 2,
  representation: 2,
  resource: 1,
  semantic_assertion: 4,
};

/** How each delta table's rows are tied to the drive's new bodies ($1). */
function tiedTo(table: string): string {
  const s = q(S());
  switch (table) {
    case "objects":
      return "t.id = ANY($1::text[])";
    case "graphiti_projection_outbox":
      return "t.object_id = ANY($1::text[])";
    case "artifact_materializations":
      return `t.artifact_id = ANY($1::text[]) AND t.run_id = '${RUN_SEND}' AND t.path = 'email_fanout'`;
    case "resource":
      return `t.id IN (SELECT p.resource_id FROM ${s}."representation" p WHERE p.artifact_id = ANY($1::text[]))`;
    case "artifact_blobs":
      return `t.id IN (SELECT r.metadata->>'blobId' FROM ${s}."resource" r
                 JOIN ${s}."representation" p ON p.resource_id = r.id WHERE p.artifact_id = ANY($1::text[]))`;
    default:
      return "t.artifact_id = ANY($1::text[])";
  }
}

/**
 * The rows the first drive may add: per delta table, the rows tied to its new
 * bodies that `before` did not hold, read in `before`'s columns.
 */
async function permittedFirstDriveRows(
  client: Client,
  before: Snapshot,
  newIds: string[],
): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const table of Object.keys(FIRST_DRIVE_DELTA)) {
    const columns = before.tables.get(table)?.columns;
    if (columns === undefined) throw new Error(`the schema has no table ${table}`);
    const res = await client.query<{ r: string }>(
      `SELECT ROW(${columns.map((c) => `t.${q(c)}`).join(", ")})::text AS r FROM ${q(S())}.${q(table)} t WHERE ${tiedTo(table)}`,
      [newIds],
    );
    const tied: Tables = new Map([[table, { columns, rows: res.rows.map((x) => x.r).sort() }]]);
    const fresh = rowsAdded(new Map([[table, before.tables.get(table) as TableRows]]), tied)[table];
    if (fresh !== undefined) out[table] = fresh.sort();
  }
  return out;
}

/** Run every teardown step whatever an earlier one did, then fail naming each
 *  step that failed: cleanup never fails open. */
async function runTeardown(steps: ReadonlyArray<readonly [string, () => unknown]>): Promise<void> {
  const failed: string[] = [];
  for (const [label, step] of steps) {
    try {
      await step();
    } catch (err) {
      failed.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length > 0) {
    throw new Error(`the tier's teardown failed (${failed.length} step(s)): ${failed.join("; ")}`);
  }
}

function rowCount(s: Snapshot): number {
  let n = 0;
  for (const { rows } of s.tables.values()) n += rows.length;
  return n;
}

/** The named rows of one table, each as its whole-row jsonb text, by id. */
async function rowsById(table: string, ids: string[]): Promise<Record<string, string>> {
  const res = await sql(
    `SELECT t.id, to_jsonb(t)::text AS j FROM ${q(S())}.${q(table)} t WHERE t.id = ANY($1::text[])`,
    [ids],
  );
  const out: Record<string, string> = {};
  for (const r of res.rows as Array<{ id: string; j: string }>) out[r.id] = r.j;
  return out;
}

/** Every association on one artifact, each as its whole-row jsonb text. */
async function assertionsOn(artifactId: string): Promise<string[]> {
  const res = await sql(
    `SELECT to_jsonb(t)::text AS j FROM ${q(S())}."semantic_assertion" t WHERE t.artifact_id = $1`,
    [artifactId],
  );
  return (res.rows as Array<{ j: string }>).map((r) => r.j).sort();
}

// ---------------------------------------------------------------------------
// The fixture: what the database held before the cutover.
// ---------------------------------------------------------------------------

/** One raw objects row, as the send boundary's objects-save road wrote it. */
async function seedRawObject(row: {
  id: string;
  type: string;
  runId: string | null;
  externalId: string | null;
  data: Record<string, unknown>;
}) {
  await sql(
    `INSERT INTO ${q(S())}."objects"
       (id, type, data, created_at, updated_at, created_by, org_id, source, run_id,
        external_id, graphiti_sync_status, version, owner_level, owner_id, visibility)
     VALUES ($1, $2, $3::jsonb, $4::timestamptz, $4::timestamptz, $5, $6, 'agent', $7,
             $8, 'pending', 1, 'organization', $6, 'organization')`,
    [
      row.id,
      row.type,
      JSON.stringify(row.data),
      BEFORE_CUTOVER,
      USER,
      ORG,
      row.runId,
      row.externalId === null ? null : row.externalId.toLowerCase(),
    ],
  );
}

/** The raw body payload the boundary wrote before the cutover (no `bodyMarkdown`). */
function rawBodyData(runId: string, draft: { id: string; contactId: string; subject: string; body: string; step: number }) {
  const externalId = fanout.emailBodyExternalId(runId, draft.id);
  return {
    externalId,
    data: {
      externalId,
      runId,
      campaignId: CAMPAIGN,
      draftItemId: draft.id,
      subject: draft.subject,
      body: draft.body,
      contactId: draft.contactId,
      step: draft.step,
    },
  };
}

async function seedAssertion(row: {
  id: string;
  artifactId: string;
  assertedBy: "agent" | "matcher" | "system";
  eligibility: "eligible" | "draft" | "archived";
  confidence: number | null;
}) {
  await sql(
    `INSERT INTO ${q(S())}."semantic_assertion"
       (id, org_id, artifact_id, extension, asserted_by, eligibility, confidence,
        asserted_at, archived_at, assertion_basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, 'classic')`,
    [
      row.id,
      ORG,
      row.artifactId,
      EMAIL_EXT,
      row.assertedBy,
      row.eligibility,
      row.confidence,
      BEFORE_CUTOVER,
      row.eligibility === "archived" ? BEFORE_CUTOVER : null,
    ],
  );
}

async function seedRun(runId: string) {
  await sql(
    `INSERT INTO ${q(S())}."agent_runs" (id, template_id, org_id, run_by, status, input_params, package_version)
       VALUES ($1, $2, $3, $4, 'running', '{}', $5)`,
    [runId, TEMPLATE, ORG, USER, producer.packageVersion],
  );
}

async function seedHistory() {
  // The raw body rows of the send under test, under the message identities the
  // ledgered fan-out now keys its writes by, and one of the older send.
  for (const [id, draft] of [
    ["hist-body-send-d1", DRAFTS[0]],
    ["hist-body-send-d2", DRAFTS[1]],
  ] as const) {
    const raw = rawBodyData(RUN_SEND, draft);
    await seedRawObject({ id, type: BODY_TYPE, runId: RUN_SEND, externalId: raw.externalId, data: raw.data });
  }
  const old = rawBodyData(RUN_OLD, { id: "d1", contactId: "contact-9", subject: "An older hello", body: BODY_OLD, step: 1 });
  await seedRawObject({ id: "hist-body-old-d1", type: BODY_TYPE, runId: RUN_OLD, externalId: old.externalId, data: old.data });

  // The recipient rows the boundary wrote beside them before the cutover: one
  // per confirmed recipient of the send, and one of the older send.
  for (const [id, runId, contactId, email] of [
    ...SEND_RECIPIENTS.map((r) => [r.rowId, RUN_SEND, r.contactId, r.email] as const),
    ["hist-recipient-old-1", RUN_OLD, "contact-9", "nine@example.test"] as const,
  ]) {
    const externalId = `email-recipient:${runId}:${contactId}`;
    await seedRawObject({
      id,
      type: RECIPIENT_TYPE,
      runId,
      externalId,
      data: { externalId, runId, campaignId: CAMPAIGN, contactId, email },
    });
  }

  // A base-type row the matcher associated with the email pack, never promoted.
  await seedRawObject({
    id: "hist-base-document-1",
    type: BASE_TYPE,
    runId: null,
    externalId: null,
    data: { title: "An uploaded letter", mime: "text/markdown" },
  });

  // The associations on those rows.
  await seedAssertion({ id: "hist-sa-send-d1", artifactId: "hist-body-send-d1", assertedBy: "agent", eligibility: "eligible", confidence: null });
  await seedAssertion({ id: "hist-sa-send-d2", artifactId: "hist-body-send-d2", assertedBy: "agent", eligibility: "eligible", confidence: null });
  await seedAssertion({ id: "hist-sa-old-d1", artifactId: "hist-body-old-d1", assertedBy: "agent", eligibility: "eligible", confidence: null });
  await seedAssertion({ id: "hist-sa-old-d1-archived", artifactId: "hist-body-old-d1", assertedBy: "system", eligibility: "archived", confidence: null });
  await seedAssertion({ id: "hist-sa-base-matcher", artifactId: "hist-base-document-1", assertedBy: "matcher", eligibility: "draft", confidence: 0.82 });

  // The body an earlier run's producer binding filed through the ledger, over
  // the SAME bytes as the send's first draft: the fan-out's own write of those
  // bytes then reaches a content-addressed resource row that already exists.
  const ownership = await materializer.resolveRunScopeOwnership({ templateId: TEMPLATE, runId: RUN_OLD, orgId: ORG });
  const bound = await materializer.writeClaimedArtifact({
    runId: RUN_OLD,
    orgId: ORG,
    createdBy: USER,
    outputId: "email_body",
    nodeId: "EndNode",
    path: "end_node_binding",
    extension: EMAIL_EXT,
    title: "Hello One",
    mime: "text/markdown",
    content: BODY_ONE,
    ownership,
    resolvedTarget: { objectTypeId: BODY_TYPE, acceptedFileMimeTypes: ["text/markdown", "text/plain"] },
    mimeDescription: "the fixture binding's MIME",
    typedData: { runId: RUN_OLD, campaignId: CAMPAIGN, subject: "Hello One", bodyMarkdown: BODY_ONE },
  });
  if (!bound.ok) throw new Error(`the fixture's binding-era body was not filed: ${bound.error}`);
  return bound.artifactId;
}

/** The production fan-out over the send, its body writer wired as the send
 *  boundary's default projection wires it, its recipients the send's own. */
async function driveFanout() {
  return fanout.materializeEmailFanout(
    {
      runScopeId: RUN_SEND,
      campaignId: CAMPAIGN,
      drafts: DRAFTS,
      // The send's confirmed recipients, as the boundary passes them
      // (trigger-email-send-use-cases.ts, runInitialSend): a recipient-keyed
      // rewrite or backfill would run here.
      recipients: SEND_RECIPIENTS.map(({ contactId, email, name }) => ({ contactId, email, name })),
    },
    {
      registeredTypes: new Set([fanout.EMAIL_BODY_TYPE_ID]),
      writeBody: (w) =>
        materializer.materializeFanoutMessageRevision({
          runId: w.runId,
          orgId: ORG,
          createdBy: USER,
          objectTypeId: fanout.EMAIL_BODY_TYPE_ID,
          outputId: w.outputId,
          title: w.title,
          markdown: w.markdown,
          typedData: w.typedData,
        }),
    },
  );
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  BLOB_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3089-blobs-"));
  process.env.CINATRA_ARTIFACT_DATA_ROOT = BLOB_ROOT;

  // The setup client is closed whatever the schema build does; a failed build
  // fails the run, and the teardown below still runs every step.
  await withTierClient("setup", newTierClient, async (client) => {
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = qy.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
      try {
        await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
      } catch (err) {
        if (!message(err).includes("does not exist")) throw err;
      }
    }
  });
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  ({ runPostgresQueriesAsync } = await import("@/lib/postgres-async"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  materializer = await import("@/lib/artifacts/run-artifact-materializer");
  fanout = await import("@/lib/trigger-email-send-use-cases");

  objectTypeRegistry._clearForTests();
  // The body type as the email pack declares it: a markdown body under the
  // declared `bodyMarkdown` field.
  objectTypeRegistry.register(
    {
      type: BODY_TYPE,
      category: "report",
      schema: z
        .object({ runId: z.string(), subject: z.string(), bodyMarkdown: z.string() })
        .catchall(z.unknown()),
      lifecycle: { sources: ["agent", "user", "import"], mutableBy: ["agent", "user"] },
      renderers: { listRow: null, card: null, detail: null },
      isArtifact: { accepts: { file: { mimeTypes: ["text/markdown", "text/plain"] } } },
      dispositions: { projection: "artifact-safe" },
    } as never,
    EMAIL_EXT,
  );
  await sql(
    `INSERT INTO ${q(S())}."artifact_type_claims"
       (id, scope, object_type_id, claim_kind, extension_package, extension_version, status, generation, dispositions)
     VALUES ('claim-3089-body', $1, $2, 'dedicated', $3, '1.0.0', 'active', 1, $4::jsonb)`,
    [`org:${ORG}`, BODY_TYPE, EMAIL_EXT, JSON.stringify({ projection: "artifact-safe" })],
  );
  await sql(
    `INSERT INTO ${q(S())}."agent_templates"
       (id, org_id, name, source_nl, compiled_plan, input_schema, approval_policy, status,
        package_name, package_version, owner_level, owner_id)
     VALUES ($1, $2, '3089 outreach fixture', 'n/a', '{}', '{}', 'auto', 'active',
             $3, '1.0.0', 'organization', $2)`,
    [TEMPLATE, ORG, producer.packageName],
  );
  await seedRun(RUN_OLD);
  await seedRun(RUN_SEND);
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  // Every step runs whatever an earlier one did, and the run then fails naming
  // each step that failed. Each client is built, connected and closed inside its
  // own step, so a malformed setting, a refused connection or a failed close is
  // one failed step: it never skips the blob root or the process state, and the
  // tier never finishes green with its schema or a session left behind.
  await runTeardown([
    ["clear the type registry", () => objectTypeRegistry._clearForTests()],
    [
      "drop the tier's schema",
      () =>
        withTierClient("teardown", newTierClient, (client) =>
          client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`),
        ),
    ],
    [
      "leave no session of the tier open",
      () =>
        withTierClient("teardown", newTierClient, async (client) => {
          const left = await tierSessionsLeft(client);
          if (left > 0) throw new Error(`${left} session(s) of the tier are still open`);
        }),
    ],
    [
      "remove the blob root",
      () => {
        if (BLOB_ROOT) rmSync(BLOB_ROOT, { recursive: true, force: true });
      },
    ],
    [
      "reset the process state",
      () => {
        delete process.env.CINATRA_ARTIFACT_DATA_ROOT;
        delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
          .__cinatraPostgresSchemaInitialized;
      },
    ],
  ]);
});

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 5 — the fan-out run twice leaves the historical raw rows and associations byte-identical",
  () => {
    let reader: Client | undefined;
    let boundArtifactId = "";
    // `before` is read in each table's own columns. Every later reading is read
    // twice: over the columns `before` saw (what "byte-identical" compares, so a
    // column a later DDL might add cannot pose as a changed row), and over the
    // first drive's columns (what the second drive is compared against).
    let before: Snapshot;
    let afterFirst: Snapshot;
    let afterFirstAsBefore: Snapshot;
    let afterSecond: Snapshot;
    let afterSecondAsBefore: Snapshot;
    let objectsBefore: Record<string, string>;
    let assertionsBefore: Record<string, string>;
    let boundAssertionsBefore: string[];
    let permitted: Record<string, string[]>;
    let first: Awaited<ReturnType<typeof driveFanout>>;
    let second: Awaited<ReturnType<typeof driveFanout>>;

    beforeAll(async () => {
      boundArtifactId = await seedHistory();
      const client = await openTierClient("reader", newTierClient);
      reader = client;
      before = await snapshot(client);
      objectsBefore = await rowsById("objects", [...HISTORICAL_OBJECT_IDS, boundArtifactId]);
      assertionsBefore = await rowsById("semantic_assertion", HISTORICAL_ASSERTION_IDS);
      boundAssertionsBefore = await assertionsOn(boundArtifactId);
      first = await driveFanout();
      afterFirst = await snapshot(client);
      afterFirstAsBefore = await snapshot(client, before);
      permitted = await permittedFirstDriveRows(client, before, first.bodies.map((b) => b.objectId));
      second = await driveFanout();
      afterSecond = await snapshot(client, afterFirst);
      afterSecondAsBefore = await snapshot(client, before);
    });

    // The reader is closed, and a failed close fails the run.
    afterAll(async () => {
      await runTeardown([
        [
          "close the reader",
          async () => {
            if (reader !== undefined) await reader.end();
          },
        ],
      ]);
    });

    it("drives the production fan-out twice: one ledgered body per draft, the second drive the same ids", async () => {
      // The fixture is what it claims to be: every historical row was read.
      expect(Object.keys(objectsBefore).sort()).toEqual([...HISTORICAL_OBJECT_IDS, boundArtifactId].sort());
      expect(Object.keys(assertionsBefore).sort()).toEqual([...HISTORICAL_ASSERTION_IDS].sort());

      expect(first.skipped.bodies).toBe(false);
      expect(first.bodies.map((b) => b.externalId)).toEqual(
        DRAFTS.map((d) => fanout.emailBodyExternalId(RUN_SEND, d.id)),
      );
      expect(first.bodies.every((b) => b.isNew)).toBe(true);
      const ids = first.bodies.map((b) => b.objectId);
      // New artifacts — not the raw rows of the same identity, not the
      // binding-era body of the same bytes.
      expect(new Set(ids).size).toBe(DRAFTS.length);
      for (const id of ids) {
        expect(HISTORICAL_OBJECT_IDS).not.toContain(id);
        expect(id).not.toBe(boundArtifactId);
      }
      expect(second.bodies.map((b) => b.objectId)).toEqual(ids);
      expect(second.bodies.every((b) => !b.isNew)).toBe(true);

      // Each one is a finalized `email_fanout` ledger row under its message
      // identity, and the text is under the declared field.
      const ledger = await sql(
        `SELECT output_id, artifact_id FROM ${q(S())}."artifact_materializations"
          WHERE run_id = $1 AND path = 'email_fanout' AND phase = 'finalized'`,
        [RUN_SEND],
      );
      const byOutput = (a: { output_id: string }, b: { output_id: string }) =>
        a.output_id < b.output_id ? -1 : a.output_id > b.output_id ? 1 : 0;
      expect([...(ledger.rows as Array<{ output_id: string; artifact_id: string }>)].sort(byOutput)).toEqual(
        first.bodies.map((b) => ({ output_id: b.externalId, artifact_id: b.objectId })).sort(byOutput),
      );
      const written = await sql(
        `SELECT id, data->>'bodyMarkdown' AS md FROM ${q(S())}."objects" WHERE id = ANY($1::text[])`,
        [ids],
      );
      expect(new Set((written.rows as Array<{ md: string }>).map((r) => r.md))).toEqual(
        new Set([BODY_ONE, BODY_TWO]),
      );
      // The first drive wrote rows of its own; this is what makes the readings
      // below a reading of a database the fan-out actually wrote to.
      expect(rowCount(afterFirst)).toBeGreaterThan(rowCount(before));
    });

    it("leaves every row the database held before the first drive byte-identical, in every table, after both drives", () => {
      expect(before.tables.size).toBeGreaterThan(0);
      expect(rowsGone(before.tables, afterFirstAsBefore.tables)).toEqual({});
      expect(rowsGone(before.tables, afterSecondAsBefore.tables)).toEqual({});
    });

    it("adds exactly the first drive's own rows: the new bodies' rows, in an exact count per table, and no other row", () => {
      // The schema itself did not change shape: the same relations, of the same
      // kinds, and the same columns on every ordinary table.
      expect(afterFirst.shape).toEqual(before.shape);
      const added = rowsAdded(before.tables, afterFirstAsBefore.tables);
      expect(Object.fromEntries(Object.entries(added).map(([t, rows]) => [t, rows.length]))).toEqual(
        FIRST_DRIVE_DELTA,
      );
      // Each added row is one the new bodies own: a copy of a raw row under a
      // new id, or anything added on a historical row, is not.
      expect(Object.fromEntries(Object.entries(added).map(([t, rows]) => [t, [...rows].sort()]))).toEqual(permitted);
    });

    it("leaves the historical raw rows as they were written: no backfill into bodyMarkdown, no revision, no ledger row", async () => {
      expect(await rowsById("objects", [...HISTORICAL_OBJECT_IDS, boundArtifactId])).toEqual(objectsBefore);

      const bodies = await sql(
        `SELECT id, type, data ? 'body' AS has_body, data ? 'bodyMarkdown' AS has_md
           FROM ${q(S())}."objects" WHERE id = ANY($1::text[])`,
        [HISTORICAL_BODY_IDS],
      );
      const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      expect([...(bodies.rows as Array<{ id: string }>)].sort(byId)).toEqual(
        [...HISTORICAL_BODY_IDS].sort().map((id) => ({ id, type: BODY_TYPE, has_body: true, has_md: false })),
      );
      const revisions = await sql(
        `SELECT count(*)::int AS n FROM ${q(S())}."representation" WHERE artifact_id = ANY($1::text[])`,
        [HISTORICAL_OBJECT_IDS],
      );
      expect(Number((revisions.rows[0] as { n: number }).n)).toBe(0);
      const ledger = await sql(
        `SELECT count(*)::int AS n FROM ${q(S())}."artifact_materializations" WHERE artifact_id = ANY($1::text[])`,
        [HISTORICAL_OBJECT_IDS],
      );
      expect(Number((ledger.rows[0] as { n: number }).n)).toBe(0);
    });

    it("leaves the existing associations as they were, and adds none on a historical row", async () => {
      expect(await rowsById("semantic_assertion", HISTORICAL_ASSERTION_IDS)).toEqual(assertionsBefore);
      const onHistory = await sql(
        `SELECT id FROM ${q(S())}."semantic_assertion" WHERE artifact_id = ANY($1::text[])`,
        [HISTORICAL_OBJECT_IDS],
      );
      expect((onHistory.rows as Array<{ id: string }>).map((r) => r.id).sort()).toEqual(
        [...HISTORICAL_ASSERTION_IDS].sort(),
      );
      // The binding-era body's own associations, filed by its producer before
      // the drive, are untouched too.
      expect(boundAssertionsBefore.length).toBeGreaterThan(0);
      expect(await assertionsOn(boundArtifactId)).toEqual(boundAssertionsBefore);
    });

    it("files the producer's association on each new body from the declared package, superseded by the claim's binding", async () => {
      // The producer chain read the fixture package at the version the run
      // pins, with the registry config: the branch did not degrade.
      expect(producer.reads.length).toBeGreaterThan(0);
      expect(producer.reads).toEqual(
        producer.reads.map(() => ({
          packageName: producer.packageName,
          packageVersion: producer.packageVersion,
          configOk: true,
        })),
      );
      const ids = first.bodies.map((b) => b.objectId).sort();
      const rows = await sql(
        `SELECT artifact_id, extension, asserted_by, eligibility, assertion_basis, binding_claim_id, binding_generation
           FROM ${q(S())}."semantic_assertion" WHERE artifact_id = ANY($1::text[])
          ORDER BY artifact_id, assertion_basis`,
        [ids],
      );
      expect(rows.rows).toEqual(
        ids.flatMap((id) => [
          {
            artifact_id: id,
            extension: EMAIL_EXT,
            asserted_by: "system",
            eligibility: "eligible",
            assertion_basis: "binding",
            binding_claim_id: "claim-3089-body",
            binding_generation: 1,
          },
          {
            artifact_id: id,
            extension: EMAIL_EXT,
            asserted_by: "agent",
            eligibility: "archived",
            assertion_basis: "classic",
            binding_claim_id: null,
            binding_generation: null,
          },
        ]),
      );
      // The run the producer validated is the one recorded on each revision.
      const reps = await sql(
        `SELECT artifact_id, created_by_run_id FROM ${q(S())}."representation"
          WHERE artifact_id = ANY($1::text[]) ORDER BY artifact_id`,
        [ids],
      );
      expect(reps.rows).toEqual(ids.map((id) => ({ artifact_id: id, created_by_run_id: RUN_SEND })));
    });

    it("changes no row and adds none on the second drive, and leaves the schema's shape as the first drive left it", () => {
      expect(afterSecond.shape).toEqual(afterFirst.shape);
      expect(rowsGone(afterFirst.tables, afterSecond.tables)).toEqual({});
      expect(rowsGone(afterSecond.tables, afterFirst.tables)).toEqual({});
    });

    it("tears down by running every step and failing on any step that fails", async () => {
      const ran: string[] = [];
      await expect(
        runTeardown([
          [
            "drop",
            () => {
              ran.push("drop");
              throw new Error("the drop was refused");
            },
          ],
          [
            "close",
            async () => {
              ran.push("close");
            },
          ],
          [
            "remove",
            () => {
              ran.push("remove");
              throw new Error("the removal was refused");
            },
          ],
        ]),
      ).rejects.toThrow(
        "the tier's teardown failed (2 step(s)): drop: the drop was refused; remove: the removal was refused",
      );
      expect(ran).toEqual(["drop", "close", "remove"]);
      await expect(runTeardown([["only", () => {}]])).resolves.toBeUndefined();
    });

    it("builds, connects and closes each client of the tier on one road, failing on every failed stage", async () => {
      const calls: string[] = [];
      const stand = (fail: { connect?: string; end?: string } = {}) => ({
        connect: async () => {
          calls.push("connect");
          if (fail.connect) throw new Error(fail.connect);
        },
        query: async () => {
          calls.push("name");
          return { rows: [{ application_name: TIER_APPLICATION_NAME }] };
        },
        end: async () => {
          calls.push("end");
          if (fail.end) throw new Error(fail.end);
        },
      });
      const malformed = (): TierClient => {
        throw new Error("Invalid URL");
      };
      const take = () => calls.splice(0, calls.length);

      // A malformed setting: the build throws, the body never runs, nothing is left to close.
      await expect(
        withTierClient("teardown", malformed, async () => {
          calls.push("run");
        }),
      ).rejects.toThrow("the teardown client failed (build: Invalid URL)");
      expect(take()).toEqual([]);
      // A refused connection: the body never runs, and the built client is closed.
      await expect(
        withTierClient("setup", () => stand({ connect: "refused" }), async () => {
          calls.push("run");
        }),
      ).rejects.toThrow("the setup client failed (connect: refused)");
      expect(take()).toEqual(["connect", "end"]);
      // A failed body and a failed close: the close still runs, and both are named.
      await expect(
        withTierClient("setup", () => stand({ end: "the close was refused" }), async () => {
          calls.push("run");
          throw new Error("the schema build was refused");
        }),
      ).rejects.toThrow("the setup client failed (run: the schema build was refused; close: the close was refused)");
      expect(take()).toEqual(["connect", "name", "run", "end"]);
      // A failed close alone fails the call.
      await expect(
        withTierClient("teardown", () => stand({ end: "the close was refused" }), async () => "dropped"),
      ).rejects.toThrow("the teardown client failed (close: the close was refused)");
      expect(take()).toEqual(["connect", "name", "end"]);
      // The reader's road: a refused connection closes the client and fails, naming a failed close too.
      await expect(
        openTierClient("reader", () => stand({ connect: "refused", end: "the close was refused" })),
      ).rejects.toThrow("the reader client failed (connect: refused; close: the close was refused)");
      expect(take()).toEqual(["connect", "end"]);
      // A good client: the body's result, and one close.
      await expect(withTierClient("teardown", () => stand(), async () => "dropped")).resolves.toBe("dropped");
      expect(take()).toEqual(["connect", "name", "end"]);
      // In the teardown, a client that cannot be built is one failed step; the later steps run.
      const ran: string[] = [];
      await expect(
        runTeardown([
          ["drop the tier's schema", () => withTierClient("teardown", malformed, async () => {})],
          [
            "remove the blob root",
            () => {
              ran.push("remove");
            },
          ],
        ]),
      ).rejects.toThrow(
        "the tier's teardown failed (1 step(s)): drop the tier's schema: the teardown client failed (build: Invalid URL)",
      );
      expect(ran).toEqual(["remove"]);
    });

    it("reads an ordinary table's rows, keeps an index or a sequence as shape, and refuses every other relation kind", () => {
      expect(relationRole("objects", "r")).toBe("rows");
      expect(relationRole("objects_pkey", "i")).toBe("shape");
      expect(relationRole("a_table_id_seq", "S")).toBe("shape");
      for (const kind of ["p", "f", "v", "m", "c", "I", "t", "toString"]) {
        expect(() => relationRole("email_backfill", kind)).toThrow(
          `the schema holds email_backfill, a relation of kind '${kind}' whose rows this tier does not read`,
        );
      }
      // The readings above read the shape: the schema's ordinary tables and their indexes.
      const kinds = new Set([...before.shape.values()].map((r) => r.kind));
      expect(kinds.has("r")).toBe(true);
      expect(kinds.has("i")).toBe(true);
      expect([...before.tables.keys()]).toEqual(
        [...before.shape].filter(([, r]) => r.kind === "r").map(([name]) => name),
      );
    });

    it("reads each client's application name from its session and refuses a client whose session carries another", async () => {
      const calls: string[] = [];
      const stand = (answer: { rows?: unknown[]; read?: string; end?: string }) => ({
        connect: async () => {
          calls.push("connect");
        },
        query: async (text: string) => {
          calls.push(text);
          if (answer.read) throw new Error(answer.read);
          return { rows: answer.rows ?? [] };
        },
        end: async () => {
          calls.push("end");
          if (answer.end) throw new Error(answer.end);
        },
      });
      const take = () => calls.splice(0, calls.length);
      const show = "SHOW application_name";

      // The session carries the tier's name: the client is handed over open.
      const good = stand({ rows: [{ application_name: TIER_APPLICATION_NAME }] });
      await expect(openTierClient("reader", () => good)).resolves.toBe(good);
      expect(take()).toEqual(["connect", show]);
      // Another name, as a URL with its own application_name gives the session:
      // the client is closed, the body never runs, and the call fails.
      await expect(
        withTierClient("teardown", () => stand({ rows: [{ application_name: "another-app" }] }), async () => {
          calls.push("run");
        }),
      ).rejects.toThrow(`the teardown client failed (name: ${NAME_REFUSED})`);
      expect(take()).toEqual(["connect", show, "end"]);
      // No row, an empty name or no name column: refused as well.
      for (const rows of [[], [{ application_name: "" }], [{}]]) {
        await expect(openTierClient("setup", () => stand({ rows }))).rejects.toThrow(
          `the setup client failed (name: ${NAME_REFUSED})`,
        );
        expect(take()).toEqual(["connect", show, "end"]);
      }
      // The read itself fails, and so does the close: both are named.
      await expect(
        openTierClient("reader", () => stand({ read: "the read was refused", end: "the close was refused" })),
      ).rejects.toThrow("the reader client failed (name: the read was refused; close: the close was refused)");
      expect(take()).toEqual(["connect", show, "end"]);
      // The refusal never repeats the session's name.
      const err = await openTierClient("reader", () => stand({ rows: [{ application_name: "another-app" }] })).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(message(err)).not.toContain("another-app");
      take();
    });
  },
);
