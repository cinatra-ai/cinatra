// REAL-POSTGRES proof of the page capture budget (cinatra#4223).
//
// A query double cannot show what the budget exists for: two server processes
// share one limit, a race at the limit admits no extra capture, a restart keeps
// what a run spent, and a lease that was never released stops counting as in
// flight at its TTL. Each "process" here is its own pg Pool; every transaction
// runs on its own pooled client, so the advisory lock really serializes them.
//
// Runner (the repo's DB-integration contract; this tier is excluded by default):
//   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
//     pnpm exec vitest run src/lib/artifacts/__tests__/page-capture-budget.integration.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";

import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";
import { pageCaptureLeasesSchemaQueries } from "@/lib/artifacts/publication-operation-schema";
import {
  acquirePageCaptureLease,
  pageCaptureBudgetLockKey,
  type PageCaptureBudgetDeps,
  type PageCaptureBudgetQuery,
} from "@/lib/artifacts/page-capture-budget";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const RUN_DB = process.env.CINATRA_DB_INTEGRATION_TESTS === "1" && DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const SCHEMA = `t4223_budget_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

const pools: Pool[] = [];
function newProcess(): Pool {
  const pool = new Pool({ connectionString: DB_URL, max: 8 });
  pools.push(pool);
  return pool;
}

function depsOn(pool: Pool, extra: Partial<PageCaptureBudgetDeps> = {}): PageCaptureBudgetDeps {
  const query: PageCaptureBudgetQuery = async <T = unknown>(text: string, values?: readonly unknown[]) =>
    (await pool.query(text, values ? [...values] : undefined)).rows as T[];
  return {
    schema: SCHEMA,
    query,
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(async <T = unknown>(text: string, values?: readonly unknown[]) =>
          (await client.query(text, values ? [...values] : undefined)).rows as T[],
        );
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    ...extra,
  };
}

let admin: Pool;
async function rowsOf(orgId: string, runId: string) {
  return (
    await admin.query(
      `SELECT count(*)::int AS total, (count(*) FILTER (WHERE released_at IS NULL))::int AS open
         FROM "${SCHEMA}"."page_capture_leases" WHERE org_id = $1 AND run_id = $2`,
      [orgId, runId],
    )
  ).rows[0] as { total: number; open: number };
}

beforeAll(async () => {
  if (!RUN_DB) return;
  admin = newProcess();
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
  for (const q of pageCaptureLeasesSchemaQueries(SCHEMA)) await admin.query(q.text);
});

afterAll(async () => {
  if (!RUN_DB) return;
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  for (const pool of pools) await pool.end().catch(() => {});
});

describe.skipIf(!RUN_DB)("page capture budget on a real Postgres (cinatra#4223)", () => {
  it("two processes share one run cap of 20; the other run and the other organisation keep their own", async () => {
    const a = depsOn(newProcess());
    const b = depsOn(newProcess());
    for (let i = 0; i < 20; i += 1) {
      const answer = await acquirePageCaptureLease({ orgId: "org-cap", runId: "run-cap" }, i % 2 ? a : b);
      expect(answer.ok).toBe(true);
      if (answer.ok) await answer.lease.release();
    }
    expect(await acquirePageCaptureLease({ orgId: "org-cap", runId: "run-cap" }, a)).toEqual({
      ok: false,
      reason: "run_cap_exceeded",
    });
    expect(await acquirePageCaptureLease({ orgId: "org-cap", runId: "run-cap" }, b)).toEqual({
      ok: false,
      reason: "run_cap_exceeded",
    });
    expect(await rowsOf("org-cap", "run-cap")).toEqual({ total: 20, open: 0 });
    expect((await acquirePageCaptureLease({ orgId: "org-cap", runId: "run-other" }, a)).ok).toBe(true);
    expect((await acquirePageCaptureLease({ orgId: "org-other", runId: "run-cap" }, b)).ok).toBe(true);
  });

  it("a restart keeps what the run spent: a fresh process still refuses the run", async () => {
    const fresh = depsOn(newProcess());
    expect(await acquirePageCaptureLease({ orgId: "org-cap", runId: "run-cap" }, fresh)).toEqual({
      ok: false,
      reason: "run_cap_exceeded",
    });
  });

  it("six racing calls from two processes admit exactly two; a release admits the next", async () => {
    const a = depsOn(newProcess());
    const b = depsOn(newProcess());
    const run = { orgId: "org-race", runId: "run-race" };
    const answers = await Promise.all(
      Array.from({ length: 6 }, (_, i) => acquirePageCaptureLease(run, i % 2 ? a : b)),
    );
    const admitted = answers.filter((x) => x.ok);
    expect(admitted).toHaveLength(2);
    expect(answers.filter((x) => !x.ok).map((x) => (x.ok ? "" : x.reason))).toEqual(
      Array(4).fill("concurrency_exceeded"),
    );
    expect(await rowsOf("org-race", "run-race")).toEqual({ total: 2, open: 2 });
    const first = admitted[0];
    if (!first.ok) throw new Error("expected a lease");
    await first.lease.release();
    expect((await acquirePageCaptureLease(run, a)).ok).toBe(true);
    expect(await rowsOf("org-race", "run-race")).toEqual({ total: 3, open: 2 });
  });

  it("a lease that was never released stops counting as in flight at its TTL, and still counts toward the cap", async () => {
    const short = depsOn(newProcess(), { limits: { perRun: 3, concurrent: 2, ttlSeconds: 1 } });
    const run = { orgId: "org-ttl", runId: "run-ttl" };
    expect((await acquirePageCaptureLease(run, short)).ok).toBe(true);
    expect((await acquirePageCaptureLease(run, short)).ok).toBe(true);
    expect(await acquirePageCaptureLease(run, short)).toEqual({ ok: false, reason: "concurrency_exceeded" });
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await acquirePageCaptureLease(run, short)).ok).toBe(true);
    expect(await acquirePageCaptureLease(run, short)).toEqual({ ok: false, reason: "run_cap_exceeded" });
    expect(await rowsOf("org-ttl", "run-ttl")).toEqual({ total: 3, open: 3 });
  });

  it("calls that waited on the lock longer than the TTL are admitted with live leases, so a fresh call cannot exceed the cap", async () => {
    const run = { orgId: "org-stale", runId: "run-stale" };
    const short = depsOn(newProcess(), { limits: { perRun: 20, concurrent: 2, ttlSeconds: 1 } });
    // A holder takes the run's lock and keeps it past the TTL; two calls begin their transactions and wait behind it.
    const holder = await admin.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      pageCaptureBudgetLockKey(run.orgId, run.runId),
    ]);
    const waiting = [acquirePageCaptureLease(run, short), acquirePageCaptureLease(run, short)];
    await new Promise((r) => setTimeout(r, 1_800));
    await holder.query("COMMIT");
    holder.release();
    const admitted = await Promise.all(waiting);
    expect(admitted.map((x) => x.ok)).toEqual([true, true]);
    // Their leases were stamped after the wait: both are still in flight now, so a fresh call is refused.
    expect(await acquirePageCaptureLease(run, short)).toEqual({ ok: false, reason: "concurrency_exceeded" });
    expect(await rowsOf(run.orgId, run.runId)).toEqual({ total: 2, open: 2 });
  });

  it("an insert whose answer is lost leaves no lease behind: the transaction rolls back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = newProcess();
    const lossy: PageCaptureBudgetDeps = {
      ...depsOn(pool),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn(async <T = unknown>(text: string, values?: readonly unknown[]) => {
            const rows = (await client.query(text, values ? [...values] : undefined)).rows as T[];
            return /^INSERT INTO/.test(text) ? ([] as T[]) : rows; // the insert ran; its answer is lost
          });
          await client.query("COMMIT");
          return out;
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    };
    const run = { orgId: "org-lossy", runId: "run-lossy" };
    expect(await acquirePageCaptureLease(run, lossy)).toEqual({ ok: false, reason: "budget_unavailable" });
    expect(await rowsOf(run.orgId, run.runId)).toEqual({ total: 0, open: 0 });
    vi.restoreAllMocks();
  });

  it("a store it cannot use refuses budget_unavailable and takes no lease", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = depsOn(newProcess(), { schema: `${SCHEMA}_missing` });
    expect(await acquirePageCaptureLease({ orgId: "org-x", runId: "run-x" }, missing)).toEqual({
      ok: false,
      reason: "budget_unavailable",
    });
    vi.restoreAllMocks();
  });
});
