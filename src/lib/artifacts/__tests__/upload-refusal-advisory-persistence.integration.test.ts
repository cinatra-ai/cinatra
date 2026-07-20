/**
 * cinatra#1890 (epic #1883 A2 / D6) — upload-refusal advisory PERSISTENCE +
 * OCCURRENCE-DEDUP, REAL-DB integration proof. Drives the real notifications
 * primitive (`createNotificationForRecipient`) with the real advisory input
 * builder against the real `notifications_dedupe_key_idx` partial unique index:
 * a second refusal of the SAME MIME collapses to ONE bell row; a distinct MIME
 * is a distinct occurrence. No mocks on the notifications write path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

// The root vitest config aliases @/lib/database to a stub whose connection
// string is host "stub" — notifications-host reads getPostgresConnectionString
// from there. Provide the REAL postgres-config primitives (the blob-store
// integration suite's pattern) so the notifications writes land on the verify DB.
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

const TEST_SCHEMA = "cinatra_test_upload_refusal_1890";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
const USER = "user-refusal-1890";

describe.skipIf(!HAS_REAL_DB)("cinatra#1890 upload-refusal advisory persistence (real DB)", () => {
  let client: Client;
  let priorSchemaEnv: string | undefined;
  let createNotificationForRecipient: typeof import("@cinatra-ai/notifications/server")["createNotificationForRecipient"];
  let buildUploadRefusalNotificationInput: typeof import("../upload-refusal-advisory")["buildUploadRefusalNotificationInput"];
  let uploadRefusalDedupeKey: typeof import("../upload-refusal-advisory")["uploadRefusalDedupeKey"];

  beforeAll(async () => {
    priorSchemaEnv = process.env.SUPABASE_SCHEMA;
    process.env.SUPABASE_SCHEMA = TEST_SCHEMA;

    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);

    const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
    for (const q of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
      const head = q.text.trim().slice(0, 6).toUpperCase();
      if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
      try {
        await client.query(q.text, (q as { values?: unknown[] }).values as never[]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("does not exist")) throw err;
      }
    }
    (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

    // Register the notifications host adapters, then load the real primitive +
    // advisory builders (after the schema env is set).
    await import("@/lib/notifications-host");
    ({ createNotificationForRecipient } = await import("@cinatra-ai/notifications/server"));
    ({ buildUploadRefusalNotificationInput, uploadRefusalDedupeKey } = await import(
      "../upload-refusal-advisory"
    ));
  });

  afterAll(async () => {
    await client?.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`).catch(() => {});
    await client?.end().catch(() => {});
    delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized;
    if (priorSchemaEnv === undefined) delete process.env.SUPABASE_SCHEMA;
    else process.env.SUPABASE_SCHEMA = priorSchemaEnv;
  });

  async function rowsFor(dedupeKey: string): Promise<Array<{ kind: string; href: string | null }>> {
    const res = await client.query(
      `SELECT kind, href FROM "${TEST_SCHEMA}"."notifications" WHERE user_id = $1 AND dedupe_key = $2`,
      [USER, dedupeKey],
    );
    return res.rows as Array<{ kind: string; href: string | null }>;
  }

  it("persists ONE info bell row per (user, refused-MIME) — repeat refusals dedupe", async () => {
    const input = buildUploadRefusalNotificationInput({
      normalizedMime: "application/zip",
      filename: "bundle.zip",
    });
    // Two refusals of the SAME mime → occurrence dedupe collapses to one row.
    await createNotificationForRecipient({ kind: "user", userId: USER }, input);
    await createNotificationForRecipient({ kind: "user", userId: USER }, input);

    const rows = await rowsFor(uploadRefusalDedupeKey("application/zip"));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("info");
    expect(rows[0].href).toBe("/configuration/marketplace?accepts=application%2Fzip");
  });

  it("a distinct refused MIME is a distinct occurrence (separate bell row)", async () => {
    await createNotificationForRecipient(
      { kind: "user", userId: USER },
      buildUploadRefusalNotificationInput({ normalizedMime: "text/markdown" }),
    );
    expect(await rowsFor(uploadRefusalDedupeKey("text/markdown"))).toHaveLength(1);
    // The zip occurrence is untouched (still exactly one).
    expect(await rowsFor(uploadRefusalDedupeKey("application/zip"))).toHaveLength(1);
  });
});
