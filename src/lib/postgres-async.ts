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
// `max` such calls wedge every later caller too. The five migrated
// notification clears each ABSORB their own failure by design — four swallow it,
// and #2838's hold clear turns it into a non-ack the park sweep retries — so a
// promise that never settles would have been a silent, permanent leak in every
// one of them.
//
// So the settle guarantee lives HERE, at the seam, and every caller inherits
// it without writing anything:
//
//   connectionTimeoutMillis — bounds the CHECKOUT. `pool.connect()` rejects
//     instead of waiting forever behind a stuck peer. Client-side; never
//     touches the wire.
//   query_timeout — bounds the client's WAIT for an answer, and is THE bound
//     that makes this promise settle. Client-side too (pg arms a timer per
//     query, `pg/lib/client.js`), so it holds against ANY DSN — direct
//     Postgres, PgBouncer, Supavisor, anything. On expiry pg abandons the
//     in-flight query while leaving the socket open, so the protocol stream is
//     desynced and that client is `release(err)`-DESTROYED rather than handed
//     to the next caller.
//   SET LOCAL statement_timeout — the server-side cancel, and ONLY inside the
//     `transaction: true` path (see `beginTransactionSql`). Postgres cancels
//     the statement, lock waits included, and answers 57014; the connection
//     stays healthy and goes straight back to the pool.
//
// WHY THE SERVER-SIDE BOUND IS NOT A POOL-CONFIG KEY — do not "simplify" this
// back. `pg` treats `statement_timeout` (and `lock_timeout`,
// `idle_in_transaction_session_timeout`) in a Pool/Client config as a
// PostgreSQL STARTUP PARAMETER: `Client.getStartupConf()` copies it straight
// into the startup packet. A PgBouncer/Supavisor-class pooler only forwards
// startup parameters it allowlists and answers anything else with a FATAL
// `unsupported startup parameter: statement_timeout` — so behind such a DSN
// EVERY `pool.connect()` fails, and because the five migrated notification
// clears absorb rejections by design — four swallow them, and #2838's hold clear
// reports a non-ack its sweep just retries — notifications would silently stop
// being deleted. Supabase DSNs commonly route through exactly that kind of pooler.
// The bound therefore must not depend on the startup packet, which is why the
// universally-enforced one is client-side and the server-side one is issued as
// in-transaction SQL.
//
// WHAT THE NON-TRANSACTION PATH GIVES UP, stated honestly. `query_timeout`
// never sends a CancelRequest — it removes the query from pg's queue and
// reports an error, and a Postgres backend blocked on a lock does not notice
// the client is gone until it next tries to write. So a single autocommit
// statement that blows the ceiling keeps running server-side until it finishes
// on its own. The CALLER is still bounded, which is the guarantee this seam
// owes; buying the server-side cancel here too would mean session-level `SET`
// state on a pooled connection, which under transaction-mode pooling leaks
// onto whatever transaction lands on that server connection next. `SET LOCAL`
// cannot leak that way — it is reverted at COMMIT/ROLLBACK — which is exactly
// why it is safe in the transaction path and unavailable outside it.
//
// All of these surface as an ORDINARY rejection: the best-effort `catch` blocks
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
//
// And bounded FROM ABOVE, which is not a taste call — above 2^31-1 ms BOTH
// mechanisms that enforce this ceiling stop working, in opposite and equally
// silent ways:
//
//   `SET LOCAL statement_timeout` — `statement_timeout` is a Postgres GUC of
//     type integer, in milliseconds, so its maximum is 2147483647. Ask for
//     more and the server refuses the SET (`... is outside the valid range for
//     parameter "statement_timeout"`). Because that SET travels WITH the BEGIN
//     as one round trip (`beginTransactionSql`), the transaction path would
//     then fail on its FIRST statement, before any caller query runs at all.
//   `query_timeout` / `connectionTimeoutMillis` — pg arms both with
//     `setTimeout`, whose delay is a signed 32-bit integer. Node clamps an
//     out-of-range delay to 1ms (with a `TimeoutOverflowWarning` and nothing
//     else), so a ceiling asked to be enormous becomes an INSTANT read timeout
//     on every query — the precise opposite of the intent, and it would look
//     to every caller like a database that answers nothing.
//
// So an over-large value does not degrade gracefully in either direction, and
// `Number.isFinite(raw) && raw > 0` does not catch it: only the exponent forms
// that reach `Infinity` (`1e400`) fail that test, while the ones that stay
// finite (`1e10`) pass it and land squarely in the broken range.
//
// The clamp is at ONE HOUR rather than at the 2147483647 both limits sit on.
// This value is a SETTLE guarantee: past an hour the promise has not settled
// in any sense a caller or an operator cares about, and 2^31-1 ms is 24.8 days
// — representable, and meaningless. Every value this repo actually sets is far
// under it (30s default, 4s in `vitest.integration-2882.config.ts`, and 90s
// for the sibling sync ceiling under a Turbopack-starved dev server), so the
// clamp only ever engages on a value that was a mistake. Clamped rather than
// rejected back to the default because the intent of an over-large value is
// "wait a very long time"; answering it with the longest bound this seam can
// actually enforce honours that, where falling back to 30s would quietly
// SHORTEN the ceiling for the one env-override use case it exists to serve.
const MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.POSTGRES_ASYNC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0
    ? Math.min(raw, MAX_TIMEOUT_MS)
    : 30_000;
})();

// The transaction path's server-side cancel sits BELOW the client's read
// timeout, so that when the server is answering at all the CLEAN bound wins
// deterministically rather than racing: Postgres cancels, answers 57014, and
// the client is rolled back and returned to the pool intact. Losing that race
// would only cost a destroyed connection, so the margin does not need to be
// large — 10% of the ceiling (3s at the 30s default) is many round trips on any
// link where the server is reachable.
const SERVER_CANCEL_FRACTION = 0.9;
const TRANSACTION_STATEMENT_TIMEOUT_MS = Math.max(
  1,
  Math.floor(DEFAULT_TIMEOUT_MS * SERVER_CANCEL_FRACTION),
);

/**
 * `BEGIN` and the transaction-scoped server-side cancel, as ONE simple-query
 * round trip.
 *
 * They are a single statement string on purpose: it makes "the `SET LOCAL`
 * never travels outside a transaction block" structural rather than a thing a
 * later edit has to remember. `SET` takes no bind parameters, so the value is
 * interpolated — it is `Math.floor`ed from an env read above that is
 * `Number.isFinite`-validated AND clamped to `MAX_TIMEOUT_MS`, so it is always
 * a positive integer inside `statement_timeout`'s int32 range, never caller
 * input.
 */
function beginTransactionSql(): string {
  return `BEGIN; SET LOCAL statement_timeout = ${TRANSACTION_STATEMENT_TIMEOUT_MS}`;
}

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
      // NO `statement_timeout` (nor `lock_timeout` /
      // `idle_in_transaction_session_timeout`) — pg would put it in the STARTUP
      // PACKET and a pooler that does not allowlist it rejects every checkout.
      // See the ceiling comment above; `postgres-async-pool-config.test.ts`
      // pins it.
      query_timeout: DEFAULT_TIMEOUT_MS,
    },
  });
}

// The exact Error pg raises when `query_timeout` fires (pg/lib/client.js). It
// means the answer never arrived, not that the server refused — so unlike a
// `SET LOCAL statement_timeout` cancel, the connection cannot be reused.
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
 * client back — a settle guarantee enforced CLIENT-side, so it holds behind a
 * connection pooler as well as against direct Postgres. The bound is per
 * checkout and per statement rather than one wall-clock budget for the whole
 * call, so a list of N queries settles within roughly (N + 1) ceilings — a
 * settle guarantee, which is the contract, not a latency budget.
 *
 * With `transaction: true` the statements additionally carry a transaction-
 * scoped server-side `statement_timeout` just under that ceiling, so a blocked
 * statement is cancelled by Postgres and the client survives. See the ceiling
 * comment for why that cancel is issued as SQL and never as pool config.
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
  // unfit for the next caller — a client read timeout (desynced stream) or a
  // ROLLBACK that failed (the transaction is still open). A server-side
  // statement_timeout cancel is neither: it rolls back cleanly and the
  // connection goes straight back.
  let destroyOnRelease: Error | undefined;
  try {
    if (transaction) {
      // BEGIN *and* the transaction-scoped server-side cancel, together. Never
      // sent on the autocommit path: `SET LOCAL` outside a transaction block is
      // a no-op warning, and the session-scoped form it would have to become
      // is exactly the pooled-connection state leak this seam avoids.
      await client.query(beginTransactionSql());
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
      // already stopped answering. This is the ORDINARY expiry path on the
      // autocommit side, where there is no server-side cancel to beat it to it.
      destroyOnRelease = error;
    } else if (transaction) {
      // Best-effort, exactly like the sync worker's rollback: a rollback that
      // itself fails must not mask the error the caller actually needs to see,
      // so it is caught and the ORIGINAL error is what gets rethrown below.
      //
      // But "do not mask it" is not "ignore it". A ROLLBACK that fails is the
      // one case where this client is provably unfit for the pool, and for the
      // same two reasons at once:
      //
      //   - the transaction is still OPEN. The BEGIN succeeded, the caller
      //     query failed, and the statement meant to close the block did not
      //     land — so the next checkout of this client inherits an in-progress
      //     transaction, holding its locks and its snapshot, and its first
      //     statement joins that transaction instead of starting clean.
      //   - the protocol stream may be DESYNCED. The likeliest failure here is
      //     the ROLLBACK blowing `query_timeout` in its turn (a server that
      //     stopped answering answers nothing, not even a two-phase abort), and
      //     that is the same abandoned-in-flight-query state the read-timeout
      //     branch above destroys the client for.
      //
      // Neither is repaired by handing the client back, so destroy it: closing
      // the socket is what aborts the open transaction server-side. The cost of
      // being wrong is one extra connection setup; the cost of the previous
      // behaviour was a poisoned client, silently, on a best-effort path whose
      // callers swallow the error that would have named it.
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        destroyOnRelease =
          rollbackError instanceof Error
            ? rollbackError
            : new Error(String(rollbackError));
      }
    }
    throw error;
  } finally {
    client.release(destroyOnRelease);
  }
}
