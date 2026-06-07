import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";

// ---------------------------------------------------------------------------
// Notifications DDL <-> writer-SQL drift guard.
//
// The notifications table DDL + the AFTER-INSERT LISTEN/NOTIFY trigger stay
// in src/lib/drizzle-store.ts. The INSERT/SELECT writer SQL lives in a
// SEPARATE workspace package (packages/notifications/src/service.ts). With the
// two on opposite sides of a package boundary, a silent column drop on EITHER
// side would otherwise go unnoticed.
//
// This test pins BOTH sides against the SAME hardcoded EXPECTED_COLUMNS list
// (neither side derived from the other) and runs the REAL generator
// `buildCreateStoreSchemaQueries()` rather than grepping raw drizzle-store
// source text. Dropping `href` / `metadata` / `source_job_id` from EITHER the
// DDL OR service.ts fails CI.
// ---------------------------------------------------------------------------

// The exact notifications-table column set. `id` comes from the
// `CREATE TABLE ... (id text PRIMARY KEY, payload text NOT NULL)` stmt; the
// rest are `ADD COLUMN IF NOT EXISTS` statements. `payload` is the legacy
// generic column (intentionally retained, not part of the typed contract).
const EXPECTED_COLUMNS = [
  "id",
  "user_id",
  "recipient_kind",
  "recipient_id",
  "topic",
  "kind",
  "title",
  "body",
  "href",
  "metadata",
  "source_job_id",
  "source_job_name",
  "created_at",
  "read_at",
] as const;

const CONFLICT_TARGET =
  "ON CONFLICT (user_id, source_job_id, kind)";
const DEDUPE_INDEX_TARGET =
  "(user_id, source_job_id, kind) WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL";

const queries = buildCreateStoreSchemaQueries("cinatra");
const texts = queries.map((q) => q.text);

// All DDL statements that touch the notifications table.
const notificationsDdl = texts.filter(
  (t) => t.includes('"cinatra"."notifications"'),
);
const notificationsDdlBlob = notificationsDdl.join("\n");

// Read ONLY the writer SQL string(s) from the service.ts package file. Match
// the specific INSERT / SELECT / RETURNING SQL template literal(s), NOT a
// whole-file string match.
const SERVICE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "notifications",
  "src",
  "service.ts",
);
const SERVICE_SRC = readFileSync(SERVICE_PATH, "utf-8");

function extractSql(pattern: RegExp): string {
  const m = SERVICE_SRC.match(pattern);
  return m ? m[0] : "";
}

// The INSERT ... VALUES ... ON CONFLICT ... RETURNING template literal.
const insertSql = extractSql(
  /INSERT INTO \$\{schemaQualified\("notifications"\)\}[\s\S]*?RETURNING[\s\S]*?read_at`/,
);
// The list SELECT template literal.
const selectSql = extractSql(
  /SELECT id, user_id[\s\S]*?FROM \$\{schemaQualified\("notifications"\)\}[\s\S]*?LIMIT \$2`/,
);
const writerSqlBlob = `${insertSql}\n${selectSql}`;

describe("notifications schema-contract (DDL ⇄ writer-SQL drift guard)", () => {
  it("the generated DDL references EVERY expected notifications column", () => {
    expect(notificationsDdl.length).toBeGreaterThan(0);
    // `id` is in the CREATE TABLE; the rest are ADD COLUMN IF NOT EXISTS.
    expect(notificationsDdlBlob).toContain(
      'CREATE TABLE IF NOT EXISTS "cinatra"."notifications" (id text PRIMARY KEY',
    );
    for (const col of EXPECTED_COLUMNS) {
      if (col === "id") continue; // covered by the CREATE TABLE assertion
      expect(
        notificationsDdlBlob,
        `generated notifications DDL is missing an "ADD COLUMN IF NOT EXISTS ${col}" (column dropped?)`,
      ).toContain(`ADD COLUMN IF NOT EXISTS ${col} `);
    }
  });

  it("the service.ts writer SQL (INSERT + SELECT) references EVERY expected column", () => {
    expect(insertSql.length).toBeGreaterThan(0);
    expect(selectSql.length).toBeGreaterThan(0);
    for (const col of EXPECTED_COLUMNS) {
      expect(
        writerSqlBlob,
        `service.ts writer SQL no longer references column "${col}" (silent drop — DDL unchanged but writer drifted)`,
      ).toContain(col);
    }
  });

  it("the dedupe conflict target matches on BOTH sides against the fixed literal", () => {
    // DDL side: the partial UNIQUE index.
    expect(notificationsDdlBlob).toContain(
      `CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_job_kind_idx ON "cinatra"."notifications" ${DEDUPE_INDEX_TARGET}`,
    );
    // Writer side: the ON CONFLICT clause must be byte-identical to the
    // fixed conflict-target literal.
    expect(insertSql).toContain(CONFLICT_TARGET);
    expect(insertSql).toContain(
      "WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL",
    );
    expect(insertSql).toContain("DO NOTHING");
  });

  it("the AFTER INSERT LISTEN/NOTIFY trigger + function are present in the generated DDL", () => {
    const triggerFnSql = texts.find((t) =>
      t.includes(
        'CREATE OR REPLACE FUNCTION "cinatra"."fn_notify_notification_insert"()',
      ),
    );
    expect(triggerFnSql).toBeDefined();
    expect(triggerFnSql).toContain("pg_notify(");
    expect(triggerFnSql).toContain("'cinatra_notifications'");

    const triggerSql = texts.find((t) =>
      t.includes("CREATE TRIGGER trg_notifications_after_insert"),
    );
    expect(triggerSql).toBeDefined();
    expect(triggerSql).toContain(
      'AFTER INSERT ON "cinatra"."notifications"',
    );
    expect(triggerSql).toContain(
      'EXECUTE FUNCTION "cinatra"."fn_notify_notification_insert"()',
    );
  });
});
