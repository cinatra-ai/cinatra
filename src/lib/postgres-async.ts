import "server-only";

import { createHash } from "node:crypto";

import type { Pool } from "pg";

import { getPooledDb } from "@/lib/db/pooled";

/**
 * The ASYNC counterpart of `@/lib/postgres-sync`'s `runPostgresQueriesSync`
 * (cinatra#2882).
 *
 * `runPostgresQueriesSync` spawns a worker thread and parks the MAIN thread on
 * `Atomics.wait` until the worker answers or its ceiling fires
 * (`POSTGRES_SYNC_TIMEOUT_MS`, 30s by default). For the window of that wait no
 * timer, no abort listener and no microtask runs anywhere in the process — a
 * slow-but-not-dead database turns one keyed statement into up to thirty
 * seconds of a completely frozen event loop, and no `AbortSignal` can ever
 * reach it.
 *
 * This module runs the SAME query list with the SAME result shape over the
 * shared async pool (`@/lib/db/pooled`, #303) instead, so a caller that already
 * has an `await` available never crosses the bridge. It is deliberately a
 * drop-in: same input keys (`connectionString` / `queries` / `transaction`),
 * same `{ rows, rowCount }` per query, same `next build` no-op guard, same
 * throw-on-first-error behaviour, and — see `DEFAULT_TIMEOUT_MS` below — the
 * same guarantee that the call SETTLES rather than hanging. The differences
 * are that it returns a promise, and that its ceiling is enforced by the pool
 * and the server instead of by `Atomics.wait`, so the event loop keeps running
 * for the whole of it.
 *
 * This is NOT a replacement for the sync bridge: genuinely synchronous hosts
 * (module-scope schema init, sync-leaf stores that have no `await` to give)
 * keep it. See the caller inventory at the head of `@/lib/postgres-sync`.
 */

type QueryInput = {
  text: string;
  values?: unknown[];
};

type QueryResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

// Mirrors `@/lib/postgres-sync`'s build-phase guard verbatim. `next build`
// exports a placeholder SUPABASE_DB_URL that never resolves, and page-data
// collection evaluates route-handler modules whose imports reach persistence;
// answering with one empty result per query is what the sync bridge does and
// what every caller of either runner already tolerates. Duplicated rather than
// imported because postgres-sync.ts is a policed SYNC LEAF (see
// `src/lib/__tests__/postgres-sync-leaf-imports.test.ts`) and this module pulls
// in `pg` — importing this one from there, or that one from here, would either
// break the leaf contract or drag a pool onto a sync-only graph.
function isNextBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}

// One pool PER connection string. `getPooledDb` refuses to hand the same `name`
// back to a caller that resolved a different DSN (a name collision would
// silently reuse the first pool), and this runner is generic — the schema
// suites point it at a throwaway database while the app points it at
// SUPABASE_DB_URL. A short digest keys them apart without ever putting the
// DSN's credentials into a pool name that gets logged.
function poolNameFor(connectionString: string): string {
  return `postgres-async:${createHash("sha256").update(connectionString).digest("hex").slice(0, 12)}`;
}

// The CEILING every async caller inherits (cinatra#2882).
//
// The first cut of this module took no ceiling and set none, on the argument
// that an async caller bounds itself. No caller did, and the argument was
// weaker than the thing it replaced: the sync bridge ALWAYS settles —
// `Atomics.wait` returns "timed-out" after `POSTGRES_SYNC_TIMEOUT_MS` and the
// caller gets a throw it can catch. An unbounded async call is strictly worse.
// A `pool.connect()` that never resolves, or a `client.query()` that never
// answers (a persistent table lock, a half-open TCP connection), leaves the
// caller's promise unsettled FOREVER and never returns its client to the pool;
// `max` such calls wedge every later caller too. The three migrated
// notification clears swallow their errors by design, so that would have been
// a silent, permanent leak.
//
// So the settle guarantee lives HERE, at the seam, and every caller inherits
// it without writing anything:
//
//   connectionTimeoutMillis — bounds the CHECKOUT. `pool.connect()` rejects
//     instead of waiting forever behind a stuck peer.
//   statement_timeout — bounds each STATEMENT, server-side (sent in the
//     startup packet). Postgres cancels the statement, including time spent
//     waiting on a lock, and answers 57014. The connection stays healthy and
//     goes straight back to the pool, which is why this is the bound that
//     should normally fire.
//   query_timeout — bounds the client's WAIT for that answer, ABOVE
//     statement_timeout, so it only fires when no answer is coming at all.
//     pg's protocol stream is desynced afterwards, so that client is destroyed
//     on release rather than handed to the next caller.
//
// All three surface as an ORDINARY rejection: the best-effort `catch` blocks
// around the notification clears absorb them exactly as they absorbed the sync
// bridge's throw. The bound is a settle guarantee, NOT a latency target —
// generous on purpose at 30s, matching the sync bridge's default, so this
// change cannot turn a slow-but-succeeding query into a new failure. Tightening
// per call site is the separate, evidence-led piece of work argued in the
// #2882 ceiling review.
//
// Env-overridable for the same reason the sync ceiling is (see
// `@/lib/postgres-sync`): under `pnpm dev` + Turbopack, wall-clock ceilings can
// be blown by CPU starvation that is nowhere near the database's fault. Read
// ONCE at module load — `getPooledDb` fingerprints a pool's config and refuses
// a later caller that resolves a different one, so this value has to be stable
// for the life of the process.
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.POSTGRES_ASYNC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

// How much longer the CLIENT waits than the SERVER before giving up. The
// server-side cancel must win whenever the server is reachable at all, because
// it is the clean one; the client-side read timeout is only the backstop for a
// connection that has stopped answering.
const CLIENT_READ_GRACE_MS = 5_000;

/**
 * The pool this runner uses for `connectionString`, created on first use.
 *
 * Exported so a caller (or a proof) can observe pool health — `totalCount` /
 * `idleCount` / `waitingCount` — without reconstructing the name and config,
 * which `getPooledDb` requires to match exactly.
 */
export function getPostgresAsyncPool(connectionString: string): Pool {
  return getPooledDb({
    name: poolNameFor(connectionString),
    connectionString: () => connectionString,
    poolConfig: {
      connectionTimeoutMillis: DEFAULT_TIMEOUT_MS,
      statement_timeout: DEFAULT_TIMEOUT_MS,
      query_timeout: DEFAULT_TIMEOUT_MS + CLIENT_READ_GRACE_MS,
    },
  });
}

// The exact Error pg raises when `query_timeout` fires (pg/lib/client.js). It
// means the answer never arrived, not that the server refused — so unlike a
// statement_timeout cancel, the connection cannot be reused.
function isClientReadTimeout(error: unknown): error is Error {
  return error instanceof Error && error.message === "Query read timeout";
}

/**
 * Run `queries` in order against `connectionString` on the shared async pool.
 *
 * With `transaction: true` every query runs on ONE checked-out client inside a
 * single `BEGIN`/`COMMIT`, rolling back on the first failure — the same
 * contract the sync worker implements. Without it each query autocommits, but
 * they still share one client so statement ordering is preserved.
 *
 * BOUNDED: the checkout and every statement carry the ceiling documented at
 * `DEFAULT_TIMEOUT_MS`, so this promise always settles and always gives its
 * client back. The bound is per checkout and per statement rather than one
 * wall-clock budget for the whole call, so a list of N queries settles within
 * roughly (N + 1) ceilings — a settle guarantee, which is the contract, not a
 * latency budget.
 */
export async function runPostgresQueriesAsync(input: {
  connectionString: string;
  queries: QueryInput[];
  transaction?: boolean;
}): Promise<QueryResult[]> {
  if (isNextBuildPhase()) {
    return input.queries.map(() => ({
      rows: [] as Array<Record<string, unknown>>,
      rowCount: 0,
    }));
  }

  const pool = getPostgresAsyncPool(input.connectionString);

  // One client for the whole list. The sync worker opens a single pg.Client and
  // runs the list on it; checking one out here keeps that ordering guarantee
  // (and is what makes `transaction` meaningful at all).
  const client = await pool.connect();
  const transaction = input.transaction === true;
  // `release(err)` with a truthy argument DESTROYS the client instead of
  // returning it to the pool. Set only for an error that leaves the connection
  // unusable — a statement_timeout cancel does not.
  let destroyOnRelease: Error | undefined;
  try {
    if (transaction) {
      await client.query("BEGIN");
    }

    const results: QueryResult[] = [];
    for (const query of input.queries) {
      const result = await client.query(query.text, (query.values ?? []) as unknown[]);
      results.push({
        rows: result.rows as Array<Record<string, unknown>>,
        rowCount: typeof result.rowCount === "number" ? result.rowCount : 0,
      });
    }

    if (transaction) {
      await client.query("COMMIT");
    }

    return results;
  } catch (error) {
    if (isClientReadTimeout(error)) {
      // No answer ever came, so pg's protocol stream is desynced — the reply to
      // the abandoned statement would be handed to whoever checks this client
      // out next. Destroy it instead. Closing the socket is also what aborts an
      // open transaction here, which is why the ROLLBACK is skipped: sending it
      // would only wait out a second read timeout on a connection that has
      // already stopped answering.
      destroyOnRelease = error;
    } else if (transaction) {
      // Best-effort, exactly like the sync worker's rollback: a rollback that
      // itself fails must not mask the error the caller actually needs to see.
      try {
        await client.query("ROLLBACK");
      } catch {
        /* non-fatal */
      }
    }
    throw error;
  } finally {
    client.release(destroyOnRelease);
  }
}
