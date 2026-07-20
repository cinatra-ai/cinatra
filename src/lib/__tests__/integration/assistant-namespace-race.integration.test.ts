/**
 * AC#4 (cinatra#1874 Epic #1873 W1) — namespace transactionality proof against
 * REAL Postgres: the ONE advisory-locked primitive (constant-key
 * `pg_advisory_xact_lock`) serializes every flat-token write across BOTH tables
 * (`assistant_handles` + `assistant_tag_alias`), so:
 *
 *   - a concurrent alias-claim vs handle-mint on the SAME token: exactly one
 *     wins, the loser sees the token taken (inline error / suffix per rule);
 *   - a rename by principal id is atomic and collision-checked against BOTH
 *     tables.
 *
 * This is a REAL two-transaction race (two independent pg connections) — the
 * loser's transaction genuinely BLOCKS on the advisory lock until the winner
 * commits, then observes the committed row. The suite self-skips without a real
 * SUPABASE_DB_URL (same contract as the sibling integration tests); it provisions
 * only the two namespace tables (lean) via the shared bootstrap leaf builders.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { ASSISTANT_NAMESPACE_LOCK_KEY } from "@/lib/assistant-namespace-lock";
import { assistantHandleSchemaQueries } from "@/lib/assistant-thread-schema";
import { assistantRegistrySchemaQueries } from "@/lib/assistant-registry-schema";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused") &&
  !dbUrl.includes("build:build@127.0.0.1:5432/build");

const LOCK = ASSISTANT_NAMESPACE_LOCK_KEY;

async function newClient(schema: string): Promise<Client> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`SET search_path TO "${schema}"`);
  return c;
}

/** The primitive's critical section (check BOTH tables under the lock, then
 *  insert). Mirrors registerAssistantHandle / claimAssistantAlias exactly at the
 *  SQL level — the point under test is that the lock makes it atomic. */
async function tokenTaken(c: Client, token: string): Promise<"handle" | "alias" | null> {
  const r = await c.query(
    `SELECT 'handle' AS k FROM assistant_handles WHERE handle=$1
     UNION ALL SELECT 'alias' AS k FROM assistant_tag_alias WHERE alias=$1 LIMIT 1`,
    [token],
  );
  return (r.rows[0]?.k as "handle" | "alias") ?? null;
}

const maybe = hasDb ? describe : describe.skip;

maybe("AC#4 — advisory-locked namespace primitive (live race)", () => {
  let schema: string;
  let admin: Client;

  beforeAll(async () => {
    admin = new Client({ connectionString: dbUrl });
    await admin.connect();
    schema = `ns_race_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const q of [
      ...assistantHandleSchemaQueries(schema),
      ...assistantRegistrySchemaQueries(schema),
    ]) {
      // skip the builtin-alias seed INSERT so tests control their own tokens
      if (q.text.trim().toUpperCase().startsWith("INSERT")) continue;
      await admin.query(q.text);
    }
  });

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await admin.end();
    }
  });

  beforeEach(async () => {
    await admin.query(`TRUNCATE assistant_handles, assistant_tag_alias`);
  });

  it("cross-table race on the same token: exactly one wins, the loser is blocked then sees it taken", async () => {
    const a = await newClient(schema); // claims 'gemini' as a HANDLE
    const b = await newClient(schema); // claims 'gemini' as an ALIAS
    try {
      // A: BEGIN + acquire lock + check(free) + insert handle — hold the lock.
      await a.query("BEGIN");
      await a.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
      expect(await tokenTaken(a, "gemini")).toBeNull();
      await a.query(
        `INSERT INTO assistant_handles (assistant_user_id, handle, origin) VALUES ($1,'gemini','standalone')`,
        [`pA-${randomUUID()}`],
      );

      // B: BEGIN + attempt lock — genuinely BLOCKS on A's xact lock.
      await b.query("BEGIN");
      let bAcquired = false;
      const bLock = b
        .query("SELECT pg_advisory_xact_lock($1)", [LOCK])
        .then(() => {
          bAcquired = true;
        });
      // Give B a real chance to run; it must still be blocked.
      await new Promise((r) => setTimeout(r, 150));
      expect(bAcquired).toBe(false);

      // A commits → releases the lock → B unblocks.
      await a.query("COMMIT");
      await bLock;
      expect(bAcquired).toBe(true);

      // B now sees 'gemini' taken as a handle → must NOT insert the alias.
      expect(await tokenTaken(b, "gemini")).toBe("handle");
      await b.query("ROLLBACK");

      // Exactly one 'gemini' across both tables.
      const total = await admin.query(
        `SELECT (SELECT count(*) FROM assistant_handles WHERE handle='gemini')
              + (SELECT count(*) FROM assistant_tag_alias WHERE alias='gemini') AS n`,
      );
      expect(Number(total.rows[0].n)).toBe(1);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("rename by principal id is atomic and collision-checked against BOTH tables", async () => {
    const principal = `pRename-${randomUUID()}`;
    await admin.query(
      `INSERT INTO assistant_handles (assistant_user_id, handle, origin) VALUES ($1,'cinatra','standalone')`,
      [principal],
    );
    await admin.query(
      `INSERT INTO assistant_tag_alias (alias, package_name, source) VALUES ('openai','@cinatra-ai/openai-assistant','manifest')`,
    );

    const c = await newClient(schema);
    try {
      // Attempt rename cinatra→openai under the lock: 'openai' owned by an ALIAS
      // → refuse (no UPDATE), collision detected.
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
      const owner = await tokenTaken(c, "openai");
      expect(owner).toBe("alias");
      // primitive refuses; rollback
      await c.query("ROLLBACK");
      const still = await admin.query(`SELECT handle FROM assistant_handles WHERE assistant_user_id=$1`, [principal]);
      expect(still.rows[0].handle).toBe("cinatra");

      // A rename to a FREE token succeeds atomically (UPDATE WHERE PK).
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1)", [LOCK]);
      expect(await tokenTaken(c, "gemini-brain")).toBeNull();
      await c.query(`UPDATE assistant_handles SET handle='gemini-brain', is_override=true WHERE assistant_user_id=$1`, [
        principal,
      ]);
      await c.query("COMMIT");
      const renamed = await admin.query(`SELECT handle FROM assistant_handles WHERE assistant_user_id=$1`, [principal]);
      expect(renamed.rows[0].handle).toBe("gemini-brain");
    } finally {
      await c.end();
    }
  });

  it("the origin CHECK rejects an out-of-domain value (schema invariant)", async () => {
    await expect(
      admin.query(
        `INSERT INTO assistant_handles (assistant_user_id, handle, origin) VALUES ($1,'x','bogus')`,
        [`pBad-${randomUUID()}`],
      ),
    ).rejects.toThrow(/assistant_handles_origin_check|check constraint/i);
  });
});
