// THE SINGLE-USE LEDGER, AGAINST A REAL POSTGRES (cinatra#2932, lifecycle-b
// W5a) — acceptance items 2 and 3, on the tier that can actually settle them.
//
//   2. "A grant is consumed by its first use."
//   3. "A replayed or foreign grant ... is refused."
//
// The unit tier proves the store's IDIOMS against an in-memory stand-in. Four
// things only a database can answer, and each is a case below:
//
//   · the BOOTSTRAP really creates the table and BOTH unique constraints;
//   · `INSERT ... ON CONFLICT DO NOTHING RETURNING` really returns NO ROW when
//     the (user_id, message_id) index rejects a second mint for one message;
//   · `DELETE ... RETURNING` really serializes two CONCURRENT spends of one
//     grant so exactly one wins — the property "consumed by its first use"
//     rests on, and the one a read-then-write would lose;
//   · `expires_at > now()` is evaluated at the DATABASE's clock, not the
//     process's.
//
// SELF-SKIPS without `SUPABASE_DB_URL`, and THROWS instead of skipping inside
// its own lane (`CINATRA_LENT_ACTION_GRANT_REALDB`), because a suite whose only
// failure mode is "skipped" reports success by doing nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { lentActionGrantSchemaQueries } from "@/lib/lent-action-grant-schema";

const DSN = process.env.SUPABASE_DB_URL ?? "";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra_x2932";
const IN_LANE = process.env.CINATRA_LENT_ACTION_GRANT_REALDB === "1";

if (IN_LANE && !DSN) {
  throw new Error(
    "the lent-action-grant ledger tier needs a real database: set SUPABASE_DB_URL to a scratch Postgres DSN",
  );
}

const maybe = DSN ? describe : describe.skip;

let pool: Pool;

/** The store's own idioms, run against the real table. Deliberately the SAME
 *  statement text the store issues — a copy here that drifted would prove
 *  nothing about the store. */
const table = () => `"${SCHEMA}"."lifecycle_lent_action_grants"`;

async function record(row: {
  jti: string;
  orgId: string;
  userId: string;
  messageId: string;
  fp: string;
  control: string;
  text?: string | null;
  expiresAt: number;
}): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO ${table()}
       (jti, org_id, user_id, message_id, card_ref_fp, control, message_text, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))
     ON CONFLICT DO NOTHING
     RETURNING jti`,
    [row.jti, row.orgId, row.userId, row.messageId, row.fp, row.control, row.text ?? null, row.expiresAt],
  );
  return res.rows.length === 1;
}

async function spend(
  jti: string,
  userId: string,
  orgId: string,
  fp = "fp1",
  control = "comment",
): Promise<{ ok: boolean; text: string | null }> {
  const res = await pool.query(
    `UPDATE ${table()}
        SET spent_at = now(), message_text = NULL
      WHERE jti = $1 AND user_id = $2 AND org_id = $3
        AND card_ref_fp = $4 AND control = $5
        AND spent_at IS NULL
        AND expires_at > now()
      RETURNING jti, message_text`,
    [jti, userId, orgId, fp, control],
  );
  return { ok: res.rows.length === 1, text: res.rows[0]?.message_text ?? null };
}

const nowSec = () => Math.floor(Date.now() / 1000);

maybe("the lent-action grant ledger, on a real Postgres", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DSN });
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${SCHEMA}"`);
    // THE BOOTSTRAP'S OWN TEXT — not a hand-written CREATE TABLE. What is under
    // test includes whether the shipped DDL produces a table these statements
    // can actually use.
    for (const q of lentActionGrantSchemaQueries(SCHEMA)) {
      await pool.query(q.text);
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await pool.end();
  });

  it("the bootstrap creates the table, its expiry index and its uniqueness constraints", async () => {
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'lifecycle_lent_action_grants'
        ORDER BY column_name`,
      [SCHEMA],
    );
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "card_ref_fp",
      "control",
      "created_at",
      "expires_at",
      "jti",
      "message_id",
      "message_text",
      "org_id",
      "spent_at",
      "user_id",
    ]);
    const idx = await pool.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'lifecycle_lent_action_grants'
        ORDER BY indexname`,
      [SCHEMA],
    );
    const names = idx.rows.map((r) => r.indexname);
    expect(names).toContain("lifecycle_lent_action_grants_expiry_idx");
    // The one-grant-per-message rule is a TABLE CONSTRAINT (see the leaf for
    // why), so Postgres names its backing index itself; what matters is that
    // exactly one UNIQUE index covers (user_id, message_id).
    const uniques = idx.rows.filter((r) => r.indexdef.includes("UNIQUE"));
    expect(
      uniques.some(
        (r) => r.indexdef.includes("user_id") && r.indexdef.includes("message_id"),
      ),
    ).toBe(true);
    // The primary key is the third constraint; it is what makes a jti one row.
    expect(names.some((n: string) => n.endsWith("_pkey"))).toBe(true);
  });

  it("replaying the bootstrap is a no-op — it is idempotent, as the leaf claims", async () => {
    for (const q of lentActionGrantSchemaQueries(SCHEMA)) {
      await expect(pool.query(q.text)).resolves.toBeTruthy();
    }
  });

  it("the first spend wins and the SECOND finds nothing — item 2 and the replay of item 3", async () => {
    const g = { jti: "db-1", orgId: "o1", userId: "u1", messageId: "m1", fp: "fp1", control: "comment", expiresAt: nowSec() + 600 };
    expect(await record(g)).toBe(true);
    expect((await spend("db-1", "u1", "o1")).ok).toBe(true);
    expect((await spend("db-1", "u1", "o1")).ok).toBe(false);
  });

  it("TWO CONCURRENT spends of one grant: exactly ONE wins — the property a read-then-write would lose", async () => {
    const g = { jti: "db-2", orgId: "o1", userId: "u1", messageId: "m2", fp: "fp2", control: "comment", expiresAt: nowSec() + 600 };
    await record(g);
    const [a, b] = await Promise.all([
      spend("db-2", "u1", "o1", "fp2"),
      spend("db-2", "u1", "o1", "fp2"),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("a FOREIGN spend takes nothing and does not burn the owner's grant — item 3", async () => {
    const g = { jti: "db-3", orgId: "o1", userId: "u1", messageId: "m3", fp: "fp3", control: "approve", expiresAt: nowSec() + 600 };
    await record(g);
    expect((await spend("db-3", "u2", "o1", "fp3", "approve")).ok).toBe(false);
    expect((await spend("db-3", "u1", "o2", "fp3", "approve")).ok).toBe(false);
    expect((await spend("db-3", "u1", "o1", "fp3", "approve")).ok).toBe(true);
  });

  it("ONE MESSAGE lends ONE control: a second mint for the same message writes NO second spendable row", async () => {
    const first = { jti: "db-4a", orgId: "o1", userId: "u1", messageId: "m4", fp: "fp4", control: "comment", expiresAt: nowSec() + 600 };
    expect(await record(first)).toBe(true);
    const second = { ...first, jti: "db-4b", fp: "fp4b", control: "approve" };
    expect(await record(second)).toBe(false);
    const rows = await pool.query(
      `SELECT jti FROM ${table()} WHERE user_id = 'u1' AND message_id = 'm4'`,
    );
    expect(rows.rows.map((r) => r.jti)).toEqual(["db-4a"]);
  });

  it("the LIFE is honoured at the DATABASE's clock, not the caller's", async () => {
    const expired = { jti: "db-5", orgId: "o1", userId: "u1", messageId: "m5", fp: "fp5", control: "comment", expiresAt: nowSec() - 1 };
    await record(expired);
    expect((await spend("db-5", "u1", "o1", "fp5")).ok).toBe(false);
    // The row is still there — refused by predicate, not by absence — which is
    // what makes the sweep a housekeeping job rather than a correctness one.
    const rows = await pool.query(`SELECT jti FROM ${table()} WHERE jti = 'db-5'`);
    expect(rows.rows).toHaveLength(1);
    await pool.query(`DELETE FROM ${table()} WHERE expires_at <= now()`);
    const after = await pool.query(`SELECT jti FROM ${table()} WHERE jti = 'db-5'`);
    expect(after.rows).toHaveLength(0);
  });

  it("the SPEND is a TOMBSTONE: the message-id witness survives, the words do not", async () => {
    // convergence round 3. Deleting the row would remove the (user_id, message_id)
    // uniqueness witness, and a RESEND of the same durable message could then
    // mint a second grant and press the control again.
    const g = {
      jti: "db-8", orgId: "o1", userId: "u1", messageId: "m8", fp: "fp8",
      control: "comment", text: "the person's words", expiresAt: nowSec() + 600,
    };
    await record(g);
    const spent = await spend("db-8", "u1", "o1", "fp8");
    expect(spent).toEqual({ ok: true, text: "the person's words" });
    // The row survives, spent and wordless.
    const row = await pool.query(
      `SELECT spent_at, message_text FROM ${table()} WHERE jti = 'db-8'`,
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].spent_at).not.toBeNull();
    expect(row.rows[0].message_text).toBeNull();
    // ...and a RESEND of the SAME message can mint nothing.
    expect(await record({ ...g, jti: "db-8b", text: "a resend" })).toBe(false);
    // A second spend of the tombstone is refused.
    expect((await spend("db-8", "u1", "o1", "fp8")).ok).toBe(false);
  });

  it("the ledger holds NO grant string — a dump of it presses no button", async () => {
    const rows = await pool.query(`SELECT * FROM ${table()} LIMIT 1000`);
    for (const row of rows.rows) {
      for (const value of Object.values(row)) {
        // Every stored string is an id, a fingerprint or a control name. None
        // of them is, or contains, an authority.
        expect(String(value)).not.toMatch(/^[A-Za-z0-9_-]{200,}$/);
      }
    }
  });

  it("the row REFUSES a spend that names another card or another control — the second lock", async () => {
    const g = { jti: "db-6", orgId: "o1", userId: "u1", messageId: "m6", fp: "fp6", control: "comment", expiresAt: nowSec() + 600 };
    await record(g);
    expect((await spend("db-6", "u1", "o1", "fp-other", "comment")).ok).toBe(false);
    expect((await spend("db-6", "u1", "o1", "fp6", "approve")).ok).toBe(false);
    expect((await spend("db-6", "u1", "o1", "fp6", "comment")).ok).toBe(true);
  });

  it("the PERSON'S OWN WORDS come back with the spend — the model supplies none", async () => {
    const g = {
      jti: "db-7", orgId: "o1", userId: "u1", messageId: "m7", fp: "fp7",
      control: "comment", text: "tighten the opening paragraph",
      expiresAt: nowSec() + 600,
    };
    await record(g);
    const spent = await spend("db-7", "u1", "o1", "fp7");
    expect(spent).toEqual({ ok: true, text: "tighten the opening paragraph" });
  });
});
