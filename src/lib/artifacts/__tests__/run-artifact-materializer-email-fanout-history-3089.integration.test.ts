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
 * is closed whatever failed after it. Each client reads its own session after
 * the connect: a session that carries another name (a URL's own
 * `application_name` wins over the Client option) fails the run, and the
 * session's backend (its pid and start time) is recorded. The teardown finds a
 * session of the tier that was left open by that backend, so a session that
 * changed its name after the connect is still found. The teardown runs every
 * step (schema drop, a check that the reading outside the tier's schema did not
 * change, a check that no session of the tier is left open, blob root, process
 * state) whatever fails, and then fails the run naming each step that failed.
 *
 * ISOLATION: a fresh schema from the CANONICAL `buildCreateStoreSchemaQueries`
 * DDL, of which the setup runs only the statements aimed at that schema. The
 * canonical build also alters tables of `public` (Better Auth's `team`,
 * `member`, `user`, `organization` and `session`) and puts triggers on them.
 * The setup takes the repository's replay selection (`selectReplayStatements`,
 * cinatra#3559, which leaves out the statements on shared `public` tables),
 * then runs a statement only when its target is in the fixture schema, and
 * refuses to run the build when it cannot read a statement's target. The
 * shared reading (`readShared`) reads the schemas other than the catalog's, the
 * toast and temporary ones and the fixture schema: their relations, columns,
 * constraints, indexes, triggers, functions, types, policies and rules, the
 * database's extensions, event triggers, foreign data wrappers and servers, and
 * each ordinary table's rows as a count and a digest. The setup takes it before
 * it drops a fixture schema an earlier run left. Each drop of the fixture
 * schema (the setup's and the teardown's) runs in a transaction and is rolled
 * back, keeping the schema and failing the run, when the reading after it
 * differs from the reading before it: a `CASCADE` that would take with it an
 * object outside the schema that the reading sees. The teardown reads it once
 * more and fails when it differs from the setup's reading. The artifact blob root is a temp dir; every
 * app module is imported in `beforeAll` after the env is set, because
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
import { selectReplayStatements } from "@/lib/test-support/store-schema-replay";

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

/** Every client the tier opens asks for this name, so the teardown can find a
 *  session of the tier that was left open. The production write path's pools
 *  open their sessions from the same connection string: when that string sets
 *  this name itself, their sessions carry it too, and the teardown counts them. */
const TIER_APPLICATION_NAME = "cinatra-3089-history-tier";

/** A session of the tier, known by its backend: the pid and the backend's
 *  start time. A later backend can reuse a pid, not also its start time; and
 *  unlike the name, neither can change after the connect. */
type TierSession = { pid: number; started: string };

/** Every session the tier opened, recorded as its client connects. The
 *  teardown finds a session of the tier that was left open by its backend,
 *  whatever name the session carries by then. */
const TIER_SESSIONS: TierSession[] = [];

/** What each client reads of its own session after the connect: the name the
 *  session carries, and its backend. */
const SESSION_READ =
  "SELECT current_setting('application_name') AS application_name, a.pid, a.backend_start::text AS started " +
  "FROM pg_stat_activity a WHERE a.pid = pg_backend_pid()";

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

/** Why a client whose session's backend cannot be read is refused. */
const BACKEND_UNREAD =
  "the session's backend (its pid and start time) could not be read, so the teardown could not find " +
  "the session if it were left open";

/**
 * Build and connect one client, then read its own session: the name it carries
 * and its backend. A build failure leaves nothing to close; a client that was
 * built and failed after that is closed here, and the call fails naming the
 * failed stage and any failed close.
 *
 * The name is read from the session, not trusted from the option: pg merges
 * the connection string's own parameters over the Client options, so a URL
 * with an `application_name` of its own gives every session of the tier that
 * name instead. The name is checked here once; the session can still change it
 * later (a `SET application_name`), so the session's backend is recorded in
 * `record` too, and the teardown finds a session left open by that backend.
 */
async function openTierClient<C extends TierClient>(
  label: string,
  open: () => C,
  record: TierSession[] = TIER_SESSIONS,
): Promise<C> {
  let client: C | undefined;
  let stage = "build";
  try {
    client = open();
    stage = "connect";
    await client.connect();
    stage = "session";
    const res = await client.query(SESSION_READ);
    const row = (res.rows[0] ?? {}) as { application_name?: unknown; pid?: unknown; started?: unknown };
    if (row.application_name !== TIER_APPLICATION_NAME) throw new Error(NAME_REFUSED);
    const { pid, started } = row;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof started !== "string" || started === "") {
      throw new Error(BACKEND_UNREAD);
    }
    record.push({ pid, started });
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
  record: TierSession[] = TIER_SESSIONS,
): Promise<T> {
  const client = await openTierClient(label, open, record);
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

/** The pids of the tier's sessions open now, other than the asking one: each
 *  session in `sessions` found by its backend (pid and start time), whatever
 *  name it carries now, and each session on this database that carries the
 *  tier's name. One session counts once. */
async function tierSessionsOpen(client: Client, sessions: readonly TierSession[] = TIER_SESSIONS): Promise<number[]> {
  const res = await client.query<{ pid: number }>(
    `SELECT a.pid FROM pg_stat_activity a
      WHERE a.pid <> pg_backend_pid()
        AND ((a.datname = current_database() AND a.application_name = $1)
             OR EXISTS (SELECT 1 FROM unnest($2::int[], $3::timestamptz[]) AS s(pid, started)
                         WHERE s.pid = a.pid AND s.started = a.backend_start))
      ORDER BY a.pid`,
    [TIER_APPLICATION_NAME, sessions.map((s) => s.pid), sessions.map((s) => s.started)],
  );
  return res.rows.map((r) => Number(r.pid));
}

/** How many sessions of the tier are still open, other than the asking one.
 *  A closed client's backend ends a moment after the close, so the count is
 *  read again for up to five seconds before a session is called left open. */
async function tierSessionsLeft(client: Client): Promise<number> {
  let left = 0;
  for (let i = 0; i < 50; i += 1) {
    left = (await tierSessionsOpen(client)).length;
    if (left === 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return left;
}

// ---------------------------------------------------------------------------
// The setup's reach: the statements of the canonical build it runs, and a
// reading of the objects outside the fixture schema.
// ---------------------------------------------------------------------------

/** One identifier, quoted or not. */
const IDENT = String.raw`(?:"(?:[^"]|"")+"|[\w$]+)`;
/** How the setup reads where a statement of the canonical build writes, by its
 *  shape: an index or a trigger writes the table it is ON; any other object
 *  writes the name that follows its kind. */
const DDL_TARGETS: readonly RegExp[] = [
  new RegExp(String.raw`^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(?:${IDENT} )?ON (?:ONLY )?(\S+)`, "i"),
  new RegExp(String.raw`^(?:CREATE (?:OR REPLACE )?(?:CONSTRAINT )?|DROP )TRIGGER (?:IF EXISTS )?${IDENT} (?:.*? )?ON (\S+)`, "i"),
  new RegExp(
    String.raw`^(?:CREATE (?:OR REPLACE )?|ALTER |DROP )(?:TABLE|FUNCTION|VIEW|MATERIALIZED VIEW|SEQUENCE|TYPE|SCHEMA|DOMAIN|EXTENSION|INDEX)(?: IF (?:NOT )?EXISTS)? (?:ONLY )?(\S+)`,
    "i",
  ),
];

/** The target of one statement as written (schema-qualified or not), or
 *  undefined for a shape the setup does not read. */
function ddlTarget(text: string): string | undefined {
  const flat = text.trim().replace(/\s+/g, " ");
  for (const shape of DDL_TARGETS) {
    const m = shape.exec(flat);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * Whether the setup runs one statement of the canonical build: only when its
 * target is the fixture schema or an object qualified by it. A target in
 * `public`, in another schema, or unqualified (it would land in the session's
 * `search_path`, `public` first) is skipped. A statement whose target the setup
 * cannot read stops the build: the setup never runs a statement it cannot place.
 */
function aimedAtFixture(text: string): boolean {
  const target = ddlTarget(text);
  if (target === undefined) {
    throw new Error(
      `the setup cannot tell which schema this statement writes, so it does not run the schema build: ${text.trim().slice(0, 80)}`,
    );
  }
  return target === q(TEST_SCHEMA) || target.startsWith(`${q(TEST_SCHEMA)}.`);
}

/** The schemas a shared reading leaves out by name: the catalog's own and the
 *  one schema of the tier it reads around (the fixture schema, unless a caller
 *  names another). Toast and temporary schemas are left out by their prefix in
 *  the queries below. */
const notShared = (fixture: string): string[] => ["pg_catalog", "information_schema", fixture];

/** The catalog lines of a shared reading: one line per object of the kinds
 *  below, in each schema the reading does not leave out. */
const SHARED_CATALOG = `
WITH ns AS (
  SELECT oid, nspname FROM pg_namespace WHERE nspname <> ALL($1::text[]) AND nspname !~ '^pg_(toast|temp_)'
)
SELECT 'schema ' || ns.nspname AS line FROM ns
UNION ALL
SELECT 'relation ' || ns.nspname || '.' || c.relname || ' kind ' || c.relkind::text
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
UNION ALL
SELECT 'column ' || ns.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
       || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
       || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN ns ON ns.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
 WHERE a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'constraint ' || ns.nspname || '.' || coalesce(c.relname, '-') || ' ' || o.conname || ' ' || pg_get_constraintdef(o.oid)
  FROM pg_constraint o JOIN ns ON ns.oid = o.connamespace LEFT JOIN pg_class c ON c.oid = o.conrelid
UNION ALL
SELECT 'index ' || ns.nspname || '.' || c.relname || ' ' || pg_get_indexdef(c.oid)
  FROM pg_class c JOIN ns ON ns.oid = c.relnamespace WHERE c.relkind IN ('i', 'I')
UNION ALL
SELECT 'trigger ' || ns.nspname || '.' || c.relname || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid)
  FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN ns ON ns.oid = c.relnamespace
UNION ALL
SELECT 'function ' || ns.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
       || md5(coalesce(p.prosrc, ''))
  FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
UNION ALL
SELECT 'type ' || ns.nspname || '.' || t.typname || ' ' || t.typtype::text
  FROM pg_type t JOIN ns ON ns.oid = t.typnamespace WHERE t.typtype IN ('d', 'e', 'r', 'm')
UNION ALL
SELECT 'enum ' || ns.nspname || '.' || t.typname || ' ' || e.enumlabel
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN ns ON ns.oid = t.typnamespace
UNION ALL
SELECT 'policy ' || ns.nspname || '.' || c.relname || ' ' || p.polname || ' ' || p.polcmd::text
       || coalesce(' using ' || pg_get_expr(p.polqual, p.polrelid), '')
       || coalesce(' check ' || pg_get_expr(p.polwithcheck, p.polrelid), '')
  FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN ns ON ns.oid = c.relnamespace
UNION ALL
SELECT 'rule ' || ns.nspname || '.' || c.relname || ' ' || r.rulename || ' ' || md5(pg_get_ruledef(r.oid))
  FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class JOIN ns ON ns.oid = c.relnamespace
UNION ALL
SELECT 'extension ' || e.extname || ' ' || e.extversion || ' in ' || n.nspname
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
UNION ALL
SELECT 'event trigger ' || evtname || ' ' || evtevent || ' ' || evtenabled::text FROM pg_event_trigger
UNION ALL
SELECT 'foreign data wrapper ' || fdwname FROM pg_foreign_data_wrapper
UNION ALL
SELECT 'foreign server ' || s.srvname || ' on ' || w.fdwname
  FROM pg_foreign_server s JOIN pg_foreign_data_wrapper w ON w.oid = s.srvfdw`;

/**
 * The shared reading around one schema of the tier (the fixture schema unless
 * a caller names another): each catalog line above, and each ordinary table's
 * rows in the schemas it reads as a count and a digest of their text forms.
 * Sorted, so two readings compare as multisets. The tables are read one query
 * at a time, without a lock. Not read: privileges, owners, roles, a sequence's
 * value, settings of the database or a role, operators, casts, collations,
 * text-search objects, publications, and the rows of a materialized view or a
 * foreign table.
 */
async function readShared(client: Client, fixture: string = TEST_SCHEMA): Promise<string[]> {
  const catalog = await client.query<{ line: string }>(SHARED_CATALOG, [notShared(fixture)]);
  const lines = catalog.rows.map((r) => r.line);
  const tables = await client.query<{ ns: string; rel: string }>(
    `SELECT n.nspname AS ns, c.relname AS rel FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname <> ALL($1::text[]) AND n.nspname !~ '^pg_(toast|temp_)'
      ORDER BY 1, 2`,
    [notShared(fixture)],
  );
  for (const { ns, rel } of tables.rows) {
    const res = await client.query<{ n: number; h: string }>(
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, chr(10) ORDER BY t::text), '')) AS h
         FROM ${q(ns)}.${q(rel)} t`,
    );
    lines.push(`rows ${ns}.${rel} ${res.rows[0]?.n} ${res.rows[0]?.h}`);
  }
  return lines.sort();
}

/** The lines of one shared reading that the other lacks: "- line" for a line
 *  only `before` has, "+ line" for one only `after` has (multiset). */
function sharedChanges(before: readonly string[], after: readonly string[]): string[] {
  const as = (lines: readonly string[]): Tables => new Map([["shared", { columns: [], rows: [...lines] }]]);
  const gone = rowsGone(as(before), as(after)).shared ?? [];
  const added = rowsAdded(as(before), as(after)).shared ?? [];
  return [...gone.map((l) => `- ${l}`), ...added.map((l) => `+ ${l}`)].sort();
}

/**
 * Run `body` in one transaction on `client`: committed when it succeeds, rolled
 * back when it or the commit fails. The call fails with that error, and names a
 * failed rollback too.
 */
async function inTransaction<T>(client: Client, body: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const out = await body();
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      throw new Error(`${message(err)}; rollback: ${message(rollbackErr)}`);
    }
    throw err;
  }
}

/**
 * Drop one schema of the tier, if it exists, only when the drop leaves the
 * shared reading around it as it was. Called inside the caller's transaction:
 * the drop runs under a savepoint, and when the reading after it differs from
 * the reading before it (a `CASCADE` reached an object outside the schema that
 * depends on one inside it, such as a trigger on a `public` table that runs a
 * function of a schema an earlier run left), it is rolled back to the
 * savepoint, the schema is kept, and the call fails naming up to twenty of the
 * changed lines. Returns the reading taken before the drop.
 */
async function dropSchemaKeepingShared(client: Client, schema: string): Promise<string[]> {
  const before = await readShared(client, schema);
  const found = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
  if (found.rows.length === 0) return before;
  await client.query("SAVEPOINT tier_schema_drop");
  await client.query(`DROP SCHEMA ${q(schema)} CASCADE`);
  const changes = sharedChanges(before, await readShared(client, schema));
  if (changes.length > 0) {
    await client.query("ROLLBACK TO SAVEPOINT tier_schema_drop");
    throw new Error(
      `the schema ${schema} was kept: dropping it would change ${changes.length} line(s) of the reading outside it: ` +
        changes.slice(0, 20).join("; "),
    );
  }
  await client.query("RELEASE SAVEPOINT tier_schema_drop");
  return before;
}

/** The shared reading the setup took before the schema build. */
let sharedBefore: string[] | undefined;

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
  // fails the run, and the teardown below still runs every step. The shared
  // reading is taken first, before a fixture schema an earlier run left is
  // dropped (a drop that would change it is rolled back and fails the run), and
  // before the build.
  await withTierClient("setup", newTierClient, async (client) => {
    sharedBefore = await inTransaction(client, () => dropSchemaKeepingShared(client, TEST_SCHEMA));
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    // The repository's one replay selection (cinatra#3559: the four statement
    // heads, without the build's statements on shared `public` tables), and of
    // that only what is aimed at the fixture schema.
    for (const qy of selectReplayStatements(buildCreateStoreSchemaQueries(TEST_SCHEMA))) {
      if (!aimedAtFixture(qy.text)) continue;
      try {
        await client.query(qy.text, qy.values as never[]);
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
          inTransaction(client, () => dropSchemaKeepingShared(client, TEST_SCHEMA)),
        ),
    ],
    [
      "leave the reading outside the tier's schema as the setup found it",
      () =>
        withTierClient("teardown", newTierClient, async (client) => {
          if (sharedBefore === undefined) {
            throw new Error("the reading outside the tier's schema was not taken before the schema build");
          }
          const changes = sharedChanges(sharedBefore, await readShared(client));
          if (changes.length > 0) {
            throw new Error(
              `${changes.length} line(s) of the reading outside the tier's schema changed: ${changes.slice(0, 20).join("; ")}`,
            );
          }
        }),
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
          calls.push("session");
          return { rows: [{ application_name: TIER_APPLICATION_NAME, pid: 4242, started: "2026-11-04 10:00:00.000001+00" }] };
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
      // The stand-ins' sessions are kept here, never in the tier's own record.
      const sessions: TierSession[] = [];

      // A malformed setting: the build throws, the body never runs, nothing is left to close.
      await expect(
        withTierClient(
          "teardown",
          malformed,
          async () => {
            calls.push("run");
          },
          sessions,
        ),
      ).rejects.toThrow("the teardown client failed (build: Invalid URL)");
      expect(take()).toEqual([]);
      // A refused connection: the body never runs, and the built client is closed.
      await expect(
        withTierClient(
          "setup",
          () => stand({ connect: "refused" }),
          async () => {
            calls.push("run");
          },
          sessions,
        ),
      ).rejects.toThrow("the setup client failed (connect: refused)");
      expect(take()).toEqual(["connect", "end"]);
      // A failed body and a failed close: the close still runs, and both are named.
      await expect(
        withTierClient(
          "setup",
          () => stand({ end: "the close was refused" }),
          async () => {
            calls.push("run");
            throw new Error("the schema build was refused");
          },
          sessions,
        ),
      ).rejects.toThrow("the setup client failed (run: the schema build was refused; close: the close was refused)");
      expect(take()).toEqual(["connect", "session", "run", "end"]);
      // A failed close alone fails the call.
      await expect(
        withTierClient("teardown", () => stand({ end: "the close was refused" }), async () => "dropped", sessions),
      ).rejects.toThrow("the teardown client failed (close: the close was refused)");
      expect(take()).toEqual(["connect", "session", "end"]);
      // The reader's road: a refused connection closes the client and fails, naming a failed close too.
      await expect(
        openTierClient("reader", () => stand({ connect: "refused", end: "the close was refused" }), sessions),
      ).rejects.toThrow("the reader client failed (connect: refused; close: the close was refused)");
      expect(take()).toEqual(["connect", "end"]);
      // A good client: the body's result, and one close.
      await expect(withTierClient("teardown", () => stand(), async () => "dropped", sessions)).resolves.toBe("dropped");
      expect(take()).toEqual(["connect", "session", "end"]);
      // In the teardown, a client that cannot be built is one failed step; the later steps run.
      const ran: string[] = [];
      await expect(
        runTeardown([
          ["drop the tier's schema", () => withTierClient("teardown", malformed, async () => {}, sessions)],
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
      // Each client whose session was read, and only those, was recorded by its backend.
      expect(sessions).toEqual([
        { pid: 4242, started: "2026-11-04 10:00:00.000001+00" },
        { pid: 4242, started: "2026-11-04 10:00:00.000001+00" },
        { pid: 4242, started: "2026-11-04 10:00:00.000001+00" },
      ]);
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
      // The stand-ins' sessions are kept here, never in the tier's own record.
      const sessions: TierSession[] = [];
      const backend = { pid: 4242, started: "2026-11-04 10:00:00.000001+00" };

      // The session carries the tier's name: the client is handed over open,
      // and its backend is recorded.
      const good = stand({ rows: [{ application_name: TIER_APPLICATION_NAME, ...backend }] });
      await expect(openTierClient("reader", () => good, sessions)).resolves.toBe(good);
      expect(take()).toEqual(["connect", SESSION_READ]);
      expect(sessions.splice(0, sessions.length)).toEqual([backend]);
      // Another name, as a URL with its own application_name gives the session:
      // the client is closed, the body never runs, and the call fails.
      await expect(
        withTierClient(
          "teardown",
          () => stand({ rows: [{ application_name: "another-app", ...backend }] }),
          async () => {
            calls.push("run");
          },
          sessions,
        ),
      ).rejects.toThrow(`the teardown client failed (session: ${NAME_REFUSED})`);
      expect(take()).toEqual(["connect", SESSION_READ, "end"]);
      // No row, an empty name or no name column: refused as well.
      for (const rows of [[], [{ application_name: "", ...backend }], [{ ...backend }]]) {
        await expect(openTierClient("setup", () => stand({ rows }), sessions)).rejects.toThrow(
          `the setup client failed (session: ${NAME_REFUSED})`,
        );
        expect(take()).toEqual(["connect", SESSION_READ, "end"]);
      }
      // The tier's name, but a backend the teardown could not find it by: no
      // pid, a pid that is not a positive whole number, no start time.
      for (const read of [
        { started: backend.started },
        { pid: 0, started: backend.started },
        { pid: -1, started: backend.started },
        { pid: 42.5, started: backend.started },
        { pid: "4242", started: backend.started },
        { pid: 4242 },
        { pid: 4242, started: "" },
        { pid: 4242, started: 1730714400 },
      ]) {
        await expect(
          openTierClient("setup", () => stand({ rows: [{ application_name: TIER_APPLICATION_NAME, ...read }] }), sessions),
        ).rejects.toThrow(`the setup client failed (session: ${BACKEND_UNREAD})`);
        expect(take()).toEqual(["connect", SESSION_READ, "end"]);
      }
      // The read itself fails, and so does the close: both are named.
      await expect(
        openTierClient("reader", () => stand({ read: "the read was refused", end: "the close was refused" }), sessions),
      ).rejects.toThrow("the reader client failed (session: the read was refused; close: the close was refused)");
      expect(take()).toEqual(["connect", SESSION_READ, "end"]);
      // The refusal never repeats the session's name.
      const err = await openTierClient(
        "reader",
        () => stand({ rows: [{ application_name: "another-app", ...backend }] }),
        sessions,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(message(err)).not.toContain("another-app");
      take();
      // A refused client is never recorded.
      expect(sessions).toEqual([]);
    });

    it("runs only the build's statements aimed at the fixture schema, and refuses one whose target it cannot read", () => {
      const F = q(TEST_SCHEMA);
      for (const text of [
        `CREATE SCHEMA IF NOT EXISTS ${F}`,
        `CREATE TABLE IF NOT EXISTS ${F}."objects" (id text PRIMARY KEY)`,
        `ALTER TABLE ${F}."objects"\n      ADD COLUMN IF NOT EXISTS x text`,
        `CREATE UNIQUE INDEX IF NOT EXISTS objects_x_idx ON ${F}."objects" (x)`,
        `CREATE INDEX IF NOT EXISTS objects_data_thread_idx ON ${F}."objects" (org_id, (data->>'threadId'))`,
        `CREATE OR REPLACE FUNCTION ${F}.enqueue_team_slug_move() RETURNS trigger LANGUAGE plpgsql AS $body$
          BEGIN PERFORM 1 FROM public."organization"; RETURN NEW; END; $body$`,
        `CREATE TRIGGER trg_x BEFORE UPDATE OR DELETE ON ${F}."representation" FOR EACH ROW EXECUTE FUNCTION ${F}.f()`,
        `DROP TRIGGER IF EXISTS trg_x ON ${F}."representation"`,
        `DROP TABLE IF EXISTS ${F}."legacy" CASCADE`,
      ]) {
        expect(aimedAtFixture(text), text).toBe(true);
      }
      // The canonical build's statements on public, another schema, a name that
      // only starts like the fixture's, an unqualified name, an extension.
      for (const text of [
        `ALTER TABLE public."team" ADD COLUMN IF NOT EXISTS slug text`,
        `ALTER TABLE public."team" ALTER COLUMN slug SET NOT NULL`,
        `ALTER TABLE IF EXISTS "public"."session" ADD COLUMN IF NOT EXISTS cinatra_db_created_at timestamptz DEFAULT now()`,
        `CREATE UNIQUE INDEX IF NOT EXISTS member_org_user_uniq ON public."member" ("organizationId", "userId")`,
        `DROP TRIGGER IF EXISTS user_slug_move_trg ON public."user"`,
        `CREATE TRIGGER user_slug_move_trg AFTER UPDATE OF username ON public."user"
        FOR EACH ROW EXECUTE FUNCTION ${F}.enqueue_user_slug_move()`,
        `CREATE TABLE IF NOT EXISTS "cinatra_test_another_tier"."objects" (id text)`,
        `CREATE TABLE IF NOT EXISTS ${q(`${TEST_SCHEMA}_probe`)}."objects" (id text)`,
        `CREATE TABLE IF NOT EXISTS assistant_profiles (id text PRIMARY KEY)`,
        `CREATE INDEX IF NOT EXISTS objects_x_idx ON objects (x)`,
        `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
        `CREATE SCHEMA IF NOT EXISTS "cinatra"`,
      ]) {
        expect(aimedAtFixture(text), text).toBe(false);
      }
      for (const text of [
        "ALTER DATABASE postgres SET search_path = public",
        "ALTER ROLE postgres SET search_path = public",
        "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC",
        "CREATE UNLOGGED TABLE scratch (id text)",
        'CREATE POLICY p ON public."user" USING (true)',
      ]) {
        expect(() => aimedAtFixture(text), text).toThrow("the setup cannot tell which schema this statement writes");
      }
    });

    it("reads the objects outside the fixture schema, and finds a change to one and to a table's rows there", async () => {
      // Two readings compare as multisets, naming each line one of them lacks.
      expect(sharedChanges(["a", "a", "b"], ["a", "c"])).toEqual(["+ c", "- a", "- b"]);
      expect(sharedChanges(["a", "b"], ["b", "a"])).toEqual([]);

      // A schema outside the fixture schema, as another tier's schema or
      // public would be, made inside one transaction that is rolled back: the
      // reading sees the session's own changes, and nothing is ever committed.
      const PROBE = `${TEST_SCHEMA}_probe`;
      const P = q(PROBE);
      await withTierClient("probe", newTierClient, async (client) => {
        const start = await readShared(client);
        // Nothing outside the fixture schema moved since the setup's reading.
        expect(sharedBefore).toBeDefined();
        expect(sharedChanges(sharedBefore ?? [], start)).toEqual([]);
        await client.query("BEGIN");
        try {
          await client.query(`CREATE SCHEMA ${P}`);
          await client.query(`CREATE TABLE ${P}."t" (id text PRIMARY KEY, v integer NOT NULL DEFAULT 1)`);
          await client.query(`CREATE FUNCTION ${P}."f"() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`);
          await client.query(`CREATE TRIGGER t_touch BEFORE INSERT ON ${P}."t" FOR EACH ROW EXECUTE FUNCTION ${P}."f"()`);
          const made = await readShared(client);
          const added = sharedChanges(start, made);
          for (const prefix of [
            `+ schema ${PROBE}`,
            `+ relation ${PROBE}.t kind r`,
            `+ relation ${PROBE}.t_pkey kind i`,
            `+ column ${PROBE}.t.v integer not null default 1`,
            `+ constraint ${PROBE}.t t_pkey PRIMARY KEY (id)`,
            `+ index ${PROBE}.t_pkey CREATE UNIQUE INDEX t_pkey ON `,
            `+ trigger ${PROBE}.t t_touch O CREATE TRIGGER t_touch BEFORE INSERT ON `,
            `+ function ${PROBE}.f() `,
            `+ rows ${PROBE}.t 0 `,
          ]) {
            expect(added.some((line) => line.startsWith(prefix)), prefix).toBe(true);
          }
          expect(added.every((line) => line.startsWith("+ ") && line.includes(PROBE))).toBe(true);
          // A row added there.
          await client.query(`INSERT INTO ${P}."t" (id) VALUES ('one')`);
          const filled = await readShared(client);
          expect(sharedChanges(made, filled).map((line) => line.split(" ").slice(0, 4).join(" "))).toEqual([
            `+ rows ${PROBE}.t 1`,
            `- rows ${PROBE}.t 0`,
          ]);
          // A trigger there turned off, as a trigger replaced by another would read.
          await client.query(`ALTER TABLE ${P}."t" DISABLE TRIGGER t_touch`);
          expect(sharedChanges(filled, await readShared(client)).map((line) => line.split(" ").slice(0, 5).join(" "))).toEqual([
            `+ trigger ${PROBE}.t t_touch D`,
            `- trigger ${PROBE}.t t_touch O`,
          ]);
        } finally {
          await client.query("ROLLBACK");
        }
        // Rolled back, the probe leaves the reading as it started.
        expect(sharedChanges(start, await readShared(client))).toEqual([]);
      });
    });

    it("finds a session of the tier by its backend after the session changed its name", async () => {
      const renamed = await openTierClient("renamed", newTierClient);
      let open = true;
      try {
        const pid = Number(((await renamed.query("SELECT pg_backend_pid() AS pid")).rows[0] as { pid: number }).pid);
        // A reader's own SET, after the name was checked at the connect.
        await renamed.query("SET application_name = 'k3089-renamed-after-connect'");
        const now = ((await renamed.query("SHOW application_name")).rows[0] as { application_name: string }).application_name;
        expect(now).toBe("k3089-renamed-after-connect");
        await withTierClient("session check", newTierClient, async (client) => {
          // The teardown's reading finds it by its backend; a reading by the
          // tier's name alone does not.
          expect(await tierSessionsOpen(client)).toContain(pid);
          expect(await tierSessionsOpen(client, [])).not.toContain(pid);
          await renamed.end();
          open = false;
          // Closed, it is gone: its backend ends a moment after the close.
          let still = true;
          for (let i = 0; i < 50 && still; i += 1) {
            still = (await tierSessionsOpen(client)).includes(pid);
            if (still) await new Promise((resolve) => setTimeout(resolve, 100));
          }
          expect(still).toBe(false);
        });
      } finally {
        if (open) await renamed.end();
      }
    });

    it("keeps a left schema whose drop would take an object outside it, and drops one whose drop changes nothing outside it", async () => {
      // A schema an earlier run left, whose function a trigger on a table of
      // another schema runs, as an earlier build's trigger on public.user ran
      // the fixture schema's function. Made inside one transaction that is
      // rolled back, so nothing is ever committed.
      const STALE = `${TEST_SCHEMA}_stale`;
      const PROBE = `${TEST_SCHEMA}_probe`;
      const [ST, P] = [q(STALE), q(PROBE)];
      await withTierClient("probe", newTierClient, async (client) => {
        const start = await readShared(client);
        const left = async () =>
          (
            await client.query(
              `SELECT (SELECT count(*)::int FROM pg_namespace WHERE nspname = $1) AS schemas,
                      (SELECT count(*)::int FROM pg_trigger WHERE tgname = 't_stale' AND tgrelid = to_regclass($2)) AS triggers`,
              [STALE, `${P}."t"`],
            )
          ).rows[0];
        await client.query("BEGIN");
        try {
          await client.query(`CREATE SCHEMA ${P}`);
          await client.query(`CREATE TABLE ${P}."t" (id text PRIMARY KEY)`);
          await client.query(`CREATE SCHEMA ${ST}`);
          await client.query(`CREATE FUNCTION ${ST}."f"() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`);
          await client.query(`CREATE TRIGGER t_stale AFTER UPDATE ON ${P}."t" FOR EACH ROW EXECUTE FUNCTION ${ST}."f"()`);
          // The drop would take the trigger outside the left schema with it:
          // it is rolled back, both stay, and the call names the trigger.
          await expect(dropSchemaKeepingShared(client, STALE)).rejects.toThrow(
            `the schema ${STALE} was kept: dropping it would change 1 line(s) of the reading outside it: ` +
              `- trigger ${PROBE}.t t_stale O CREATE TRIGGER t_stale AFTER UPDATE ON `,
          );
          expect(await left()).toEqual({ schemas: 1, triggers: 1 });
          // Without that dependent, the drop goes through and returns the
          // reading taken before it; a schema that is not there is no drop.
          await client.query(`DROP TRIGGER t_stale ON ${P}."t"`);
          const read = await dropSchemaKeepingShared(client, STALE);
          expect(read.some((line) => line.startsWith(`relation ${PROBE}.t kind r`))).toBe(true);
          expect(await left()).toEqual({ schemas: 0, triggers: 0 });
          await expect(dropSchemaKeepingShared(client, STALE)).resolves.toEqual(read);
        } finally {
          await client.query("ROLLBACK");
        }
        // Rolled back, the probe leaves the reading as it started.
        expect(sharedChanges(start, await readShared(client))).toEqual([]);
      });
    });
  },
);
