import "server-only";

import { createHash } from "node:crypto";

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
 * throw-on-first-error behaviour. The only differences are that it returns a
 * promise and that it does NOT take a `timeoutMs` — an async caller bounds
 * itself with the tools the event loop gives it (`AbortSignal.timeout`,
 * `Promise.race`, a statement_timeout), none of which the sync bridge can
 * offer.
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

/**
 * Run `queries` in order against `connectionString` on the shared async pool.
 *
 * With `transaction: true` every query runs on ONE checked-out client inside a
 * single `BEGIN`/`COMMIT`, rolling back on the first failure — the same
 * contract the sync worker implements. Without it each query autocommits, but
 * they still share one client so statement ordering is preserved.
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

  const pool = getPooledDb({
    name: poolNameFor(input.connectionString),
    connectionString: () => input.connectionString,
  });

  // One client for the whole list. The sync worker opens a single pg.Client and
  // runs the list on it; checking one out here keeps that ordering guarantee
  // (and is what makes `transaction` meaningful at all).
  const client = await pool.connect();
  const transaction = input.transaction === true;
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
    if (transaction) {
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
    client.release();
  }
}
