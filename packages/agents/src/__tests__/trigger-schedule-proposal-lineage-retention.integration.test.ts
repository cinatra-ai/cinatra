/**
 * cinatra#2908 — THE LINEAGE RETENTION PASS, against real Postgres.
 *
 * `trigger_schedule_proposal_lineage` shipped with an `expires_at` index and a
 * documented retention story that no code performed: nothing in the tree ever
 * deleted a row, so a replacement's ciphertext and the actor/org/template
 * identifiers beside it outlived the single TTL the schema promised, forever.
 * `sweepExpiredLineage` is that pass, and every claim it makes is a claim about
 * ONE SQL STATEMENT under real concurrency — which is why this file is against a
 * real database and not a `Map`.
 *
 *   REMOVES EXPIRED   — a row past `expires_at` is gone after one cycle.
 *   SPARES LIVE       — a row still in the future survives byte-for-byte:
 *                       token, expiry and every identifier untouched.
 *   BOUNDED           — more expired rows than the per-cycle ceiling leaves the
 *                       remainder for the next cycle instead of one unbounded
 *                       DELETE.
 *   RE-ASSERTS EXPIRY — a row ROLLED FORWARD by a live Adjust after the
 *                       statement selected it is NOT deleted. This is the case
 *                       the reasserted predicate in the DELETE's own WHERE
 *                       exists for; without it the key match alone would carry
 *                       a live slot away.
 *   IDEMPOTENT        — a second cycle immediately after is a no-op and throws
 *                       nothing.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   CINATRA_TEST_DB_URL=postgres://…  pnpm --filter @cinatra-ai/agents test:integration
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const TEST_SCHEMA = "cinatra_test_schedule_lineage_retention_2908";
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');
const ORG = "org-2908-retention";
const USER = "user-2908-reader";
const TABLE = `"${q(TEST_SCHEMA)}"."trigger_schedule_proposal_lineage"`;

let proposalStore: typeof import("../trigger-schedule-proposal-store");
let dbMod: typeof import("../db");
let client: Client;

type LineageRow = {
  consume_key: string;
  latest_token: string;
  expires_at: Date;
  org_id: string;
  template_id: string;
  reproposed_by: string;
  created_at: Date;
  updated_at: Date;
};

/** Put a row in the slot directly — the pass's subject, not its author. */
async function seedRow(over: {
  consumeKey?: string;
  token?: string;
  /** Seconds from now. Negative = already expired. */
  expiresInSeconds: number;
  templateId?: string;
}): Promise<string> {
  const consumeKey = over.consumeKey ?? `ck-${randomUUID()}`;
  await client.query(
    `INSERT INTO ${TABLE}
       (consume_key, latest_token, expires_at, org_id, template_id, reproposed_by)
     VALUES ($1, $2, now() + make_interval(secs => $3), $4, $5, $6)`,
    [
      consumeKey,
      over.token ?? `token-${consumeKey}`,
      over.expiresInSeconds,
      ORG,
      over.templateId ?? `tpl-${consumeKey}`,
      USER,
    ],
  );
  return consumeKey;
}

async function readRow(consumeKey: string): Promise<LineageRow | null> {
  const res = await client.query(`SELECT * FROM ${TABLE} WHERE consume_key = $1`, [
    consumeKey,
  ]);
  return (res.rows[0] as LineageRow | undefined) ?? null;
}

async function tableCount(): Promise<number> {
  const res = await client.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
  return res.rows[0].n as number;
}

/**
 * Block until some backend is WAITING on a lock — the point at which the
 * sweep's DELETE has genuinely reached the row the blocker is holding. Polling
 * this instead of sleeping is what keeps the refresh-during-sweep case a
 * deterministic test rather than a timing race.
 */
async function waitForLockWaiter(probe: Client, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await probe.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query ILIKE '%trigger_schedule_proposal_lineage%'`,
    );
    if ((res.rows[0].n as number) > 0) return;
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the sweep's DELETE to block on the row lock");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  if (!HAS_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.BETTER_AUTH_SECRET ??= "test-secret-for-2908-lineage-retention";

  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${q(TEST_SCHEMA)}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await admin.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await admin.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  proposalStore = await import("../trigger-schedule-proposal-store");
  dbMod = await import("../db");
  client = new Client({ connectionString: DB_URL });
  await client.connect();
}, 90_000);

beforeEach(async () => {
  if (!HAS_DB) return;
  // The pass is table-global, so each case owns the whole table.
  await client.query(`DELETE FROM ${TABLE}`);
});

afterAll(async () => {
  if (!HAS_DB) return;
  await client?.end().catch(() => {});
  await dbMod?.agentBuilderPool?.end().catch(() => {});
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`).catch(() => {});
  await admin.end().catch(() => {});
  delete (globalThis as { __cinatraPostgresSchemaInitialized?: boolean })
    .__cinatraPostgresSchemaInitialized;
});

describe.skipIf(!HAS_DB)("the lineage retention pass", () => {
  it("REMOVES EXPIRED: a row past its expiry is gone after one cycle", async () => {
    const consumeKey = await seedRow({ expiresInSeconds: -60 });
    expect(await readRow(consumeKey)).not.toBeNull();

    const result = await proposalStore.sweepExpiredLineage();

    expect(result.deleted).toBe(1);
    expect(result.more).toBe(false);
    expect(await readRow(consumeKey)).toBeNull();
  });

  it("SPARES LIVE: an un-expired row survives the cycle byte-for-byte", async () => {
    const live = await seedRow({
      expiresInSeconds: 3600,
      token: "still-holding-the-window-open",
      templateId: "tpl-live-2908",
    });
    const expired = await seedRow({ expiresInSeconds: -1 });
    const before = await readRow(live);
    expect(before).not.toBeNull();

    const result = await proposalStore.sweepExpiredLineage();

    expect(result.deleted).toBe(1);
    expect(await readRow(expired)).toBeNull();
    const after = await readRow(live);
    expect(after).not.toBeNull();
    expect(after!.latest_token).toBe("still-holding-the-window-open");
    expect(after!.expires_at.getTime()).toBe(before!.expires_at.getTime());
    expect(after!.org_id).toBe(before!.org_id);
    expect(after!.template_id).toBe("tpl-live-2908");
    expect(after!.reproposed_by).toBe(before!.reproposed_by);
    expect(after!.created_at.getTime()).toBe(before!.created_at.getTime());
    expect(after!.updated_at.getTime()).toBe(before!.updated_at.getTime());
  });

  it("BOUNDED: more expired rows than the ceiling leaves the remainder for the next cycle", async () => {
    for (let i = 0; i < 5; i++) await seedRow({ expiresInSeconds: -(i + 1) * 10 });
    expect(await tableCount()).toBe(5);

    const first = await proposalStore.sweepExpiredLineage({ limit: 2 });
    expect(first.deleted).toBe(2);
    expect(first.limit).toBe(2);
    expect(first.more).toBe(true);
    expect(await tableCount()).toBe(3);

    const second = await proposalStore.sweepExpiredLineage({ limit: 2 });
    expect(second.deleted).toBe(2);
    expect(second.more).toBe(true);
    expect(await tableCount()).toBe(1);

    const third = await proposalStore.sweepExpiredLineage({ limit: 2 });
    expect(third.deleted).toBe(1);
    expect(third.more).toBe(false);
    expect(await tableCount()).toBe(0);
  });

  it("RE-ASSERTS EXPIRY: a row rolled forward mid-sweep is not deleted", async () => {
    const consumeKey = await seedRow({ expiresInSeconds: -60, token: "the-expired-one" });

    // A live Adjust rolling the slot forward, held open so the sweep's DELETE
    // has to wait on it — exactly the window the reasserted predicate covers.
    const blocker = new Client({ connectionString: DB_URL });
    await blocker.connect();
    let result: Awaited<ReturnType<typeof proposalStore.sweepExpiredLineage>>;
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE ${TABLE}
            SET latest_token = $2, expires_at = now() + interval '1 hour', updated_at = now()
          WHERE consume_key = $1`,
        [consumeKey, "the-fresh-replacement"],
      );

      const sweeping = proposalStore.sweepExpiredLineage({ limit: 10 });
      await waitForLockWaiter(client);
      await blocker.query("COMMIT");
      result = await sweeping;
    } finally {
      // Never leave the row lock held — a stuck transaction would hang every
      // later case's table reset instead of failing this one.
      await blocker.query("ROLLBACK").catch(() => {});
      await blocker.end().catch(() => {});
    }

    expect(result.deleted).toBe(0);
    const row = await readRow(consumeKey);
    expect(row).not.toBeNull();
    expect(row!.latest_token).toBe("the-fresh-replacement");
    expect(row!.expires_at.getTime()).toBeGreaterThan(Date.now());
  }, 30_000);

  it("IDEMPOTENT: running the pass twice in a row is a no-op the second time", async () => {
    await seedRow({ expiresInSeconds: -5 });
    await seedRow({ expiresInSeconds: -5 });

    const first = await proposalStore.sweepExpiredLineage();
    expect(first.deleted).toBe(2);

    const second = await proposalStore.sweepExpiredLineage();
    expect(second.deleted).toBe(0);
    expect(second.more).toBe(false);
    expect(await tableCount()).toBe(0);
  });

  it("runs cleanly against an empty table", async () => {
    const result = await proposalStore.sweepExpiredLineage();
    expect(result).toEqual({ deleted: 0, limit: 500, more: false });
  });
});
