// REAL-POSTGRES proof of the page capture's facts record (cinatra#4223).
//
// The record is one `artifact_audit` row that the writer adds to the filing
// transaction. This suite runs the op on the real audit table (its DDL taken
// from the bootstrap): a committed transaction leaves exactly the record the
// reader returns; a transaction that fails after the op leaves none; and the
// reader answers only for its own organisation, artifact, revision and type.
// An audit row of another action whose detail carries the fact names is no
// record.
//
// Runner (the repo's DB-integration contract; this tier is excluded by default):
//   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
//     pnpm exec vitest run src/lib/artifacts/__tests__/page-capture-facts-record.integration.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// PARTIAL: only the schema init is made inert (this suite builds its own
// schema); every other member of the module stays real.
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  return { ...actual, ensurePostgresSchema: () => {} };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  buildPageCaptureFactsRecordOp,
  readPageCaptureFactsForRevision,
  type PageCaptureFactsReadDeps,
} from "@/lib/artifacts/page-capture-facts-record";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const RUN_DB = process.env.CINATRA_DB_INTEGRATION_TESTS === "1" && DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const SCHEMA = `t4223_facts_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const TYPE = "@cinatra-ai/screenshot-artifact:screenshot";
const FACTS = {
  capturedUrl: "https://shop.example/checkout",
  viewport: { width: 1440, height: 900 },
  capturedAt: "2026-11-03T07:00:00.000Z",
};

let client: Client;
const read: PageCaptureFactsReadDeps = {
  schema: SCHEMA,
  runQuery: (q) =>
    (runPostgresQueriesSync({ connectionString: DB_URL, queries: [q] })[0]?.rows ?? []) as unknown[],
};

function op(ids: { orgId: string; artifactId: string; representationRevisionId: string }, objectType = TYPE) {
  return buildPageCaptureFactsRecordOp({ schema: SCHEMA, objectType, facts: FACTS, ...ids });
}

async function inOneTransaction(statements: { text: string; values?: unknown[] }[]) {
  await client.query("BEGIN");
  try {
    for (const s of statements) await client.query(s.text, s.values as never[]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

beforeAll(async () => {
  if (!RUN_DB) return;
  client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${SCHEMA}"`);
  const audit = buildCreateStoreSchemaQueries(SCHEMA).filter((q) => q.text.includes('"artifact_audit"'));
  expect(audit.length).toBeGreaterThan(0);
  for (const q of audit) await client.query(q.text);
});

afterAll(async () => {
  if (!RUN_DB) return;
  await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await client.end();
});

describe.skipIf(!RUN_DB)("page capture facts record on a real Postgres (cinatra#4223)", () => {
  const ids = { orgId: "org-1", artifactId: "art-1", representationRevisionId: "rev-1" };

  it("a committed filing transaction leaves the record the reader returns", async () => {
    await inOneTransaction([op(ids)]);
    expect(readPageCaptureFactsForRevision({ ...ids, objectType: TYPE }, read)).toEqual({
      status: "recorded",
      facts: FACTS,
    });
  });

  it("a filing transaction that fails after the op leaves no record", async () => {
    const lost = { orgId: "org-1", artifactId: "art-2", representationRevisionId: "rev-2" };
    await expect(
      inOneTransaction([op(lost), { text: `SELECT 1 / 0` }]),
    ).rejects.toThrow();
    expect(readPageCaptureFactsForRevision({ ...lost, objectType: TYPE }, read)).toEqual({ status: "absent" });
  });

  it("answers only for its own organisation, artifact, revision and type", () => {
    for (const other of [
      { ...ids, orgId: "org-2" },
      { ...ids, artifactId: "art-9" },
      { ...ids, representationRevisionId: "rev-9" },
    ]) {
      expect(readPageCaptureFactsForRevision({ ...other, objectType: TYPE }, read)).toEqual({ status: "absent" });
    }
    expect(
      readPageCaptureFactsForRevision({ ...ids, objectType: "@cinatra-ai/chart-artifact:chart" }, read),
    ).toEqual({ status: "absent" });
  });

  it("an audit row of another action whose detail carries the fact names is no record", async () => {
    const witness = { orgId: "org-1", artifactId: "art-3", representationRevisionId: "rev-3" };
    await client.query(
      `INSERT INTO "${SCHEMA}"."artifact_audit"
        (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'create', NULL, $4::jsonb)`,
      [witness.orgId, witness.artifactId, witness.representationRevisionId, JSON.stringify({ v: 1, objectType: TYPE, ...FACTS })],
    );
    expect(readPageCaptureFactsForRevision({ ...witness, objectType: TYPE }, read)).toEqual({ status: "absent" });
  });

  it("a stored facts record whose type is null is unreadable, never absent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { orgId: "org-1", artifactId: "art-5", representationRevisionId: "rev-5" };
    await client.query(
      `INSERT INTO "${SCHEMA}"."artifact_audit"
        (id, org_id, artifact_id, representation_revision_id, action, actor, detail)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'page_capture_facts', NULL, $4::jsonb)`,
      [bad.orgId, bad.artifactId, bad.representationRevisionId, JSON.stringify({ v: 1, objectType: null, ...FACTS })],
    );
    expect(readPageCaptureFactsForRevision({ ...bad, objectType: TYPE }, read)).toEqual({ status: "unreadable" });
    vi.restoreAllMocks();
  });

  it("two records for one revision are unreadable, never facts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const twice = { orgId: "org-1", artifactId: "art-4", representationRevisionId: "rev-4" };
    await inOneTransaction([op(twice), op(twice)]);
    expect(readPageCaptureFactsForRevision({ ...twice, objectType: TYPE }, read)).toEqual({ status: "unreadable" });
    vi.restoreAllMocks();
  });
});
