/**
 * cinatra#1456 — email correlation query seam, REAL-DB integration test.
 *
 * The real send+reply-cycle evidence on real Postgres. The seam
 * (src/lib/email-correlation-queries.ts) issues, per view, an indexed
 * `objects_list { type, dataEquals }` that the store compiles to
 * `data->>'<key>' = $n` (via `compileDataEqualsClause`, exercised here directly)
 * over the email transport records. This suite writes real
 * @cinatra-ai/email:sent-email + received-reply + recipient + body rows (shapes
 * identical to the correlation writers' output — those writers are unit-tested in
 * email-transport-correlation-writers.test.ts; a live SMTP send is not required,
 * the repo has no live vitest transport) and runs the EXACT indexed SQL the seam
 * relies on against a fresh schema built with the SAME bootstrap DDL
 * (buildCreateStoreSchemaQueries, which now includes the #1456 partial expression
 * indexes), proving:
 *
 *   1. the thread view resolves the send + the reply into one bucket via the
 *      indexed data->>'threadId' lookup — ZERO email:thread row / id-array read;
 *   2. campaign view membership (sends + replies + recipients + bodies) by
 *      data.campaignId;
 *   3. the contact view is CONNECTOR-SCOPED: the same provider-native contactId
 *      under a different connector is excluded (connectorId AND contactId);
 *   4. soft-relation harmlessness: an unknown key returns nothing, and
 *      tombstoning (soft-delete) one record drops ONLY it while the sibling is
 *      read normally — correlation ids are plain strings, never references;
 *   5. the partial expression indexes exist and the threadId query plan uses one.
 *
 * The seam's VIEW-ASSEMBLY logic (which types each view reads, the dataEquals it
 * builds, the truncated flag) is covered by the unit test
 * src/lib/__tests__/email-correlation-queries.test.ts; the seam function itself
 * cannot execute under vitest because @/lib/database is stubbed there (the
 * repo's DB-integration convention: real SQL runs through _fixture, not the
 * host module graph). This suite is the real-SQL half of that pair.
 *
 * Guarded by describe.skipIf(!HAS_REAL_DB); fresh per-file schema (never the
 * shared worktree schema), per the integration convention.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { compileDataEqualsClause } from "@/lib/objects-store";
import { deriveThreadId } from "@/lib/email-thread-key";
import { connect, createTestSchema, dropSchema, insertObject } from "./_fixture";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");

const ORG = "org-1456";
const USER = "user-1456";
const CONNECTOR_A = "conn-a";
const CONNECTOR_B = "conn-b";
const PROVIDER_THREAD = "pthread-1";
const CAMPAIGN = "camp-1";
const CONTACT = "contact-9";
const THREAD_ID = deriveThreadId(CONNECTOR_A, PROVIDER_THREAD)!;

const SENT = "@cinatra-ai/email:sent-email";
const REPLY = "@cinatra-ai/email:received-reply";
const RECIPIENT = "@cinatra-ai/email:recipient";
const BODY = "@cinatra-ai/email:body";

/**
 * Run the EXACT indexed read the seam's store issues for a given type +
 * dataEquals: org scope + not-deleted + user-owner ownership (rows are seeded
 * user-owned) + the compiled `data->>'<key>' = $n` clauses. Returns ids, newest
 * first (matching listObjectsByFilter's ORDER BY created_at DESC).
 */
function seamQuery(
  client: Client,
  schema: string,
  type: string,
  dataEquals: ReadonlyArray<{ key: string; value: string }>,
): Promise<string[]> {
  const values: unknown[] = [ORG, type, USER];
  const { clauses } = compileDataEqualsClause(dataEquals, values, values.length + 1);
  const where = [
    `(org_id = $1)`,
    `deleted_at IS NULL`,
    `type = $2`,
    `(owner_level = 'user' AND owner_id = $3)`,
    ...clauses,
  ].join(" AND ");
  return client
    .query(
      `SELECT id FROM "${schema}"."objects" WHERE ${where} ORDER BY created_at DESC`,
      values,
    )
    .then((r) => r.rows.map((row) => row.id as string));
}

describe.skipIf(!HAS_REAL_DB)("cinatra#1456 email correlation query seam (real DB)", () => {
  let client: Client;
  let schema: string;
  let sentId = "";
  let replyId = "";
  let recipientId = "";
  let bodyId = "";

  const seed = (type: string, data: Record<string, unknown>) =>
    insertObject(client, schema, {
      type,
      orgId: ORG,
      ownerLevel: "user",
      ownerId: USER,
      visibility: "private",
      data,
    });

  beforeAll(async () => {
    client = await connect();
    schema = await createTestSchema(client); // includes the #1456 data indexes

    sentId = await seed(SENT, {
      connectorId: CONNECTOR_A, toEmail: "them@y.co", subject: "Hello",
      providerMessageId: "m1", providerThreadId: PROVIDER_THREAD,
      threadId: THREAD_ID, campaignId: CAMPAIGN, contactId: CONTACT,
    });
    replyId = await seed(REPLY, {
      connectorId: CONNECTOR_A, providerMessageId: "r1", providerThreadId: PROVIDER_THREAD,
      fromEmail: "them@y.co", subject: "Re: Hello",
      threadId: THREAD_ID, campaignId: CAMPAIGN, contactId: CONTACT,
    });
    recipientId = await seed(RECIPIENT, {
      connectorId: CONNECTOR_A, email: "them@y.co", campaignId: CAMPAIGN, contactId: CONTACT,
    });
    bodyId = await seed(BODY, {
      connectorId: CONNECTOR_A, subject: "Hello", campaignId: CAMPAIGN, contactId: CONTACT,
    });
    // Decoy: same contactId, DIFFERENT connector — must not leak into A's contact view.
    await seed(SENT, {
      connectorId: CONNECTOR_B, toEmail: "o@z.co", subject: "Other",
      providerMessageId: "m9", providerThreadId: "pt-other",
      threadId: deriveThreadId(CONNECTOR_B, "pt-other"), contactId: CONTACT,
    });
  }, 60_000);

  afterAll(async () => {
    if (client && schema) await dropSchema(client, schema);
    await client?.end().catch(() => {});
  });

  it("thread view: the send + the reply resolve into one bucket via the indexed threadId lookup", async () => {
    const filter = [{ key: "threadId", value: THREAD_ID }];
    expect(await seamQuery(client, schema, SENT, filter)).toEqual([sentId]);
    expect(await seamQuery(client, schema, REPLY, filter)).toEqual([replyId]);
  });

  it("campaign view membership: sends + replies + recipients + bodies by campaignId", async () => {
    const filter = [{ key: "campaignId", value: CAMPAIGN }];
    expect(await seamQuery(client, schema, SENT, filter)).toEqual([sentId]);
    expect(await seamQuery(client, schema, REPLY, filter)).toEqual([replyId]);
    expect(await seamQuery(client, schema, RECIPIENT, filter)).toEqual([recipientId]);
    expect(await seamQuery(client, schema, BODY, filter)).toEqual([bodyId]);
  });

  it("contact view is connector-scoped: same contactId under another connector is excluded", async () => {
    const filterA = [
      { key: "connectorId", value: CONNECTOR_A },
      { key: "contactId", value: CONTACT },
    ];
    expect(await seamQuery(client, schema, SENT, filterA)).toEqual([sentId]);

    const filterB = [
      { key: "connectorId", value: CONNECTOR_B },
      { key: "contactId", value: CONTACT },
    ];
    const bSends = await seamQuery(client, schema, SENT, filterB);
    expect(bSends).not.toContain(sentId);
    expect(bSends).toHaveLength(1); // connector B's own decoy send only
  });

  it("soft-relation harmlessness: an unknown correlation key returns nothing (empty view)", async () => {
    expect(await seamQuery(client, schema, SENT, [{ key: "threadId", value: "missing" }])).toEqual([]);
    expect(await seamQuery(client, schema, RECIPIENT, [{ key: "campaignId", value: "missing" }])).toEqual([]);
  });

  it("tombstone harmlessness: soft-deleting the reply drops ONLY it; the send is read normally", async () => {
    await client.query(`UPDATE "${schema}"."objects" SET deleted_at = now() WHERE id = $1`, [replyId]);
    try {
      const filter = [{ key: "threadId", value: THREAD_ID }];
      expect(await seamQuery(client, schema, REPLY, filter)).toEqual([]);
      // The send in the same thread is untouched and fully readable.
      expect(await seamQuery(client, schema, SENT, filter)).toEqual([sentId]);
    } finally {
      await client.query(`UPDATE "${schema}"."objects" SET deleted_at = NULL WHERE id = $1`, [replyId]);
    }
  });

  it("the partial expression indexes exist and the threadId query plan uses one (no seq scan)", async () => {
    const idx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2::text[])`,
      [schema, ["objects_data_thread_idx", "objects_data_campaign_idx", "objects_data_contact_idx"]],
    );
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual([
      "objects_data_campaign_idx",
      "objects_data_contact_idx",
      "objects_data_thread_idx",
    ]);

    // SET LOCAL only applies inside a transaction; wrap EXPLAIN so a tiny table
    // doesn't mask the index path, then ROLLBACK.
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query(
        `EXPLAIN SELECT id FROM "${schema}"."objects"
           WHERE org_id = $1 AND data->>'threadId' = $2 AND deleted_at IS NULL`,
        [ORG, THREAD_ID],
      );
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("objects_data_thread_idx");
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
