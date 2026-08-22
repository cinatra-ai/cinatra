// REAL-POSTGRES proof for the review-island single-use ledger (cinatra#2754).
//
// Two properties of "single use" cannot be proven against a query double, and
// both are load-bearing for the ruling:
//
//   1. ATOMICITY. `DELETE ... RETURNING` is single-use only because Postgres
//      decides, under a real row lock, which of two concurrent deletes actually
//      removed the row. Two browsers presenting the same copied address at the
//      same instant must produce exactly one paint — never two, never zero.
//   2. THE EXPIRY IS THE DATABASE'S. The 60-second life is honoured at the
//      consume against `now()` on the SERVER, not against a clock the reading
//      node supplies, so a paused or skewed node cannot revive a dead address.
//
// It runs the SAME statements the store runs (imported from it, never retyped)
// against the SAME DDL the bootstrap creates, in a lane-unique schema.
//
// Runner (the repo's standing DB-integration contract — this tier is excluded
// from the default run):
//
//   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
//     pnpm exec vitest run src/lib/lifecycle/__tests__/review-island-single-use.integration.test.ts

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import {
  REVIEW_ISLAND_GRANT_TABLE,
  reviewIslandGrantSchemaQueries,
} from "@/lib/review-island-grant-schema";
import {
  islandCredentialHash,
  reviewIslandGrantConsumeSql,
  reviewIslandGrantRecordSql,
  reviewIslandGrantSweepSql,
} from "@/lib/lifecycle/review-island-grant-store";
import { REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS } from "@/lib/lifecycle/review-island-credential";

const CONNECTION = process.env.SUPABASE_DB_URL ?? "";
const RUN = process.env.CINATRA_DB_INTEGRATION_TESTS === "1" && CONNECTION.length > 0;

const SCHEMA = `t2754_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const TABLE = `"${SCHEMA}"."${REVIEW_ISLAND_GRANT_TABLE}"`;

let pool: Pool;

/** Record one grant, exactly as the store does. `seconds` is its sealed life. */
async function record(credential: string, gate = GATE, seconds = REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS) {
  const expiresAt = Math.floor(Date.now() / 1000) + seconds;
  const res = await pool.query(reviewIslandGrantRecordSql(TABLE), [
    islandCredentialHash(credential),
    "org-A",
    "user-1",
    gate.jti,
    gate.runId,
    gate.reviewTaskId,
    expiresAt,
  ]);
  return res.rowCount ?? 0;
}

/** Spend one grant, exactly as the store does. */
async function consume(credential: string, gate = GATE) {
  const res = await pool.query(reviewIslandGrantConsumeSql(TABLE), [
    islandCredentialHash(credential),
    gate.jti,
    gate.runId,
    gate.reviewTaskId,
  ]);
  return res.rowCount ?? 0;
}

const GATE = { jti: "jti-1", runId: "run-1", reviewTaskId: "task-1" };

beforeAll(async () => {
  if (!RUN) return;
  pool = new Pool({ connectionString: CONNECTION, max: 6 });
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  for (const q of reviewIslandGrantSchemaQueries(SCHEMA)) await pool.query(q.text);
});

afterAll(async () => {
  if (!RUN) return;
  await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await pool.end();
});

describe.skipIf(!RUN)("the ledger, on a real database", () => {
  it("spends a grant exactly once — the replay finds nothing", async () => {
    const credential = "cred-replay";
    expect(await record(credential)).toBe(1);
    expect(await consume(credential)).toBe(1);
    expect(await consume(credential)).toBe(0);
  });

  it("ATOMICITY: six concurrent consumes of one address yield exactly ONE paint", async () => {
    const credential = "cred-race";
    expect(await record(credential)).toBe(1);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => consume(credential)),
    );
    expect(results.filter((r) => r === 1)).toHaveLength(1);
    expect(results.filter((r) => r === 0)).toHaveLength(5);
  });

  it("HASH-KEYED: two addresses off ONE jti each spend their own grant", async () => {
    // The exact shape of a transcript that frames two review cards at once.
    expect(await record("cred-card-a")).toBe(1);
    expect(await record("cred-card-b")).toBe(1);
    expect(await consume("cred-card-a")).toBe(1);
    // The first card's paint did not touch the second card's grant.
    expect(await consume("cred-card-b")).toBe(1);
  });

  it("THE MINUTE IS THE DATABASE'S: a grant past its life is refused at the consume", async () => {
    const credential = "cred-expired";
    expect(await record(credential, GATE, -1)).toBe(1); // sealed one second ago
    expect(await consume(credential)).toBe(0);
    // NEGATIVE CONTROL — the same shape, inside its minute, spends.
    const live = "cred-live";
    expect(await record(live, GATE, REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS)).toBe(1);
    expect(await consume(live)).toBe(1);
  });

  it("BOUND TO ITS GATE AND ITS TOKEN: another gate cannot spend this row", async () => {
    const credential = "cred-bound";
    expect(await record(credential)).toBe(1);
    expect(await consume(credential, { ...GATE, reviewTaskId: "task-2" })).toBe(0);
    expect(await consume(credential, { ...GATE, jti: "jti-2" })).toBe(0);
    // NEGATIVE CONTROL — its own gate and token still spend it.
    expect(await consume(credential)).toBe(1);
  });

  it("the sweep collects expired grants and leaves live ones alone", async () => {
    await record("cred-sweep-dead", GATE, -1);
    await record("cred-sweep-live", GATE, REVIEW_ISLAND_CREDENTIAL_TTL_SECONDS);
    await pool.query(reviewIslandGrantSweepSql(TABLE));
    const dead = await pool.query(
      `SELECT 1 FROM ${TABLE} WHERE credential_hash = $1`,
      [islandCredentialHash("cred-sweep-dead")],
    );
    const live = await pool.query(
      `SELECT 1 FROM ${TABLE} WHERE credential_hash = $1`,
      [islandCredentialHash("cred-sweep-live")],
    );
    expect(dead.rowCount).toBe(0);
    expect(live.rowCount).toBe(1);
  });

  it("stores the HASH, never the credential", async () => {
    const credential = "cred-hash-at-rest";
    await record(credential);
    const all = await pool.query(`SELECT credential_hash FROM ${TABLE}`);
    const stored = all.rows.map((r) => String(r.credential_hash));
    expect(stored).toContain(islandCredentialHash(credential));
    expect(stored).not.toContain(credential);
  });
});
