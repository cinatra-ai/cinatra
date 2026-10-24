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
 *   - the raw `email:recipient` rows the boundary wrote beside them;
 *   - the associations on those rows: the producer's eligible assertion, an
 *     archived one, and a matcher's un-promoted draft association on a
 *     base-type row;
 *   - one body an earlier run's producer binding filed through the ledger, over
 *     the SAME bytes as one draft of the send, so the fan-out's write reaches a
 *     content-addressed resource row that already exists.
 *
 * THE DRIVE is the production fan-out: `materializeEmailFanout` with its body
 * writer wired to the real `materializeFanoutMessageRevision`, exactly as the
 * send boundary's default projection wires it, run TWICE over the same send.
 *
 * THE CLAIM is read as bytes: before the first drive, every row of every table
 * in the schema is read in its text form, column by column; after both drives
 * every one of those rows must still be there, unchanged. The historical rows
 * and their associations are then read again by name, so a failure says which
 * row moved and how.
 *
 * NOT A STUB ANYWHERE THAT MATTERS. The fan-out, the ledger, the claim
 * arbitration, the type resolution, the creation path and the blob store are
 * the production ones. Substituted, as the sibling real-DB tiers substitute
 * them: the schema and connection seams the throwaway schema needs, the
 * app-boot type registrar (this suite registers the one type it needs), and
 * the meaning matcher's post-commit queue enqueue, which writes no row.
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

/** The historical rows, by name: what the cutover must leave alone. */
const HISTORICAL_OBJECT_IDS = [
  "hist-body-send-d1",
  "hist-body-send-d2",
  "hist-body-old-d1",
  "hist-recipient-send-1",
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
// The byte reading: every row of every table of the schema, as text.
// ---------------------------------------------------------------------------

type TableRows = { columns: string[]; rows: string[] };
type Snapshot = Map<string, TableRows>;

/**
 * Read every base table of the schema. Each row is its ROW(...) text form over
 * the given columns (or the table's own columns, in table order, when none are
 * given): the bytes Postgres renders for the stored values. Rows are sorted, so
 * two readings compare as multisets. ONE connection for every reading, so the
 * session settings that shape the text form (time zone, float digits) are the
 * same each time.
 */
async function snapshot(client: Client, columnsOf?: Snapshot): Promise<Snapshot> {
  const tables = await client.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
    [S()],
  );
  const out: Snapshot = new Map();
  for (const { name } of tables.rows) {
    let columns = columnsOf?.get(name)?.columns;
    if (!columns) {
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [S(), name],
      );
      columns = cols.rows.map((r) => r.column_name);
    }
    expect(columns).toBeDefined();
    if (columns === undefined) {
      throw new Error(`no column list resolved for table ${name}`);
    }
    const res = await client.query<{ r: string }>(
      `SELECT ROW(${columns.map(q).join(", ")})::text AS r FROM ${q(S())}.${q(name)}`,
    );
    out.set(name, { columns, rows: res.rows.map((x) => x.r).sort() });
  }
  return out;
}

/** The rows of `before` that are not in `after`, per table (multiset). */
function rowsGone(before: Snapshot, after: Snapshot): Record<string, string[]> {
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

function rowCount(s: Snapshot): number {
  let n = 0;
  for (const { rows } of s.values()) n += rows.length;
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
    `INSERT INTO ${q(S())}."agent_runs" (id, template_id, org_id, run_by, status, input_params)
       VALUES ($1, $2, $3, $4, 'running', '{}')`,
    [runId, TEMPLATE, ORG, USER],
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

  // The recipient rows the boundary wrote beside them before the cutover.
  for (const [id, runId, contactId, email] of [
    ["hist-recipient-send-1", RUN_SEND, "contact-1", "one@example.test"],
    ["hist-recipient-old-1", RUN_OLD, "contact-9", "nine@example.test"],
  ] as const) {
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
 *  boundary's default projection wires it. */
async function driveFanout() {
  return fanout.materializeEmailFanout(
    { runScopeId: RUN_SEND, campaignId: CAMPAIGN, drafts: DRAFTS, recipients: [] },
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
    [TEMPLATE, ORG, "@cinatra-ai/outreach-fixture-agent"],
  );
  await seedRun(RUN_OLD);
  await seedRun(RUN_SEND);
});

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  objectTypeRegistry._clearForTests();
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
  await client.end().catch(() => {});
  if (BLOB_ROOT) rmSync(BLOB_ROOT, { recursive: true, force: true });
  delete process.env.CINATRA_ARTIFACT_DATA_ROOT;
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_REAL_DB)(
  "acceptance item 5 — the fan-out run twice leaves the historical raw rows and associations byte-identical",
  () => {
    let reader: Client;
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
    let first: Awaited<ReturnType<typeof driveFanout>>;
    let second: Awaited<ReturnType<typeof driveFanout>>;

    beforeAll(async () => {
      boundArtifactId = await seedHistory();
      reader = new Client({ connectionString: DB_URL });
      await reader.connect();
      before = await snapshot(reader);
      objectsBefore = await rowsById("objects", [...HISTORICAL_OBJECT_IDS, boundArtifactId]);
      assertionsBefore = await rowsById("semantic_assertion", HISTORICAL_ASSERTION_IDS);
      first = await driveFanout();
      afterFirst = await snapshot(reader);
      afterFirstAsBefore = await snapshot(reader, before);
      second = await driveFanout();
      afterSecond = await snapshot(reader, afterFirst);
      afterSecondAsBefore = await snapshot(reader, before);
    });

    afterAll(async () => {
      await reader?.end().catch(() => {});
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
      expect(before.size).toBeGreaterThan(0);
      expect(rowsGone(before, afterFirstAsBefore)).toEqual({});
      expect(rowsGone(before, afterSecondAsBefore)).toEqual({});
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
    });

    it("changes no row and adds none on the second drive", () => {
      expect(rowsGone(afterFirst, afterSecond)).toEqual({});
      expect(rowsGone(afterSecond, afterFirst)).toEqual({});
    });
  },
);
