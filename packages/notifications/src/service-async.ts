import "server-only";

// ---------------------------------------------------------------------------
// @cinatra-ai/notifications — THE ASYNC SEAM (cinatra#2882).
//
// Every function in `./service` reaches Postgres through the host's
// `runPostgresQueriesSync` adapter, which is the synchronous bridge: a worker
// thread plus `Atomics.wait` on the MAIN thread until the worker answers or
// the 30s `POSTGRES_SYNC_TIMEOUT_MS` ceiling fires. For the whole of that wait
// no timer, no abort listener and no microtask runs anywhere in the process,
// and no `AbortSignal` can reach it — un-abortable by construction, not by
// omission (the finding PR #2875 had to design around).
//
// The callers of the notification clear are all `async` already. This module
// gives them the same statements over the host's ASYNC adapter
// (`runPostgresQueriesAsync` -> `@/lib/postgres-async` -> the shared pool), so
// they stop paying for a freeze they never needed.
//
// SCOPE, on purpose: this is a seam, not a fork. It holds the async variants
// of the specific functions whose production callers have an `await` to give,
// and each one drives the SAME statement builder its synchronous twin drives —
// see `buildDeleteNotificationsByDedupeKeyQuery`. `./service` is NOT deprecated
// and is NOT rewritten: genuinely synchronous hosts keep it.
// ---------------------------------------------------------------------------

import { getNotificationsHostAdapters } from "./host-adapters";
import { buildDeleteNotificationsByDedupeKeyQuery } from "./service";

/**
 * Resolve the host's async query runner, or fail loudly.
 *
 * Deliberately does NOT fall back to `runPostgresQueriesSync`. A silent
 * fallback would put the `Atomics.wait` freeze back under a name that promises
 * it is gone, and the callers of this seam swallow their errors by design
 * (a notification write can never fail the status transition it follows) — so
 * the regression would be invisible in exactly the place it matters. A named
 * throw is caught by that same handler and logged, which is loud enough to
 * find and honest about what happened.
 */
function requireAsyncRunner() {
  const host = getNotificationsHostAdapters();
  const runAsync = host.runPostgresQueriesAsync;
  if (!runAsync) {
    throw new Error(
      "notifications host adapters do not supply runPostgresQueriesAsync — " +
        "the async notification seam requires it. Wire it in " +
        "src/lib/notifications-host.ts (or in the adapter this test registers); " +
        "it is NOT silently backed by the synchronous Atomics.wait bridge.",
    );
  }
  return { host, runAsync };
}

/**
 * Async twin of `deleteNotificationsByDedupeKeyForUser` (cinatra#2882).
 *
 * Same statement, same guard, same idempotence, same early return on a missing
 * id — the two differ ONLY in which host adapter carries the query. The
 * hard-delete rationale is unchanged and documented on the synchronous twin:
 * these rows are ephemeral state-of-the-world entries whose meaning expires
 * the moment the underlying condition resolves, and deleting (rather than
 * marking read) frees the `(user_id, dedupe_key)` slot so a later re-gating
 * inserts a fresh UNREAD row instead of colliding with a stale read one.
 *
 * `ensurePostgresSchema()` is still called and is still synchronous. That is
 * NOT a hidden freeze: it short-circuits on a `globalThis` flag / process-local
 * done-marker after the one cold init per process (see
 * `src/lib/postgres-schema-init.ts`), so in steady state it touches no
 * database at all. Dropping it here would have been a real behaviour change —
 * the very first caller in a process would query a schema nobody had created.
 */
export async function deleteNotificationsByDedupeKeyForUserAsync(args: {
  userId: string;
  dedupeKey: string;
}): Promise<void> {
  if (!args.userId || !args.dedupeKey) return;
  const { host, runAsync } = requireAsyncRunner();
  host.ensurePostgresSchema();
  await runAsync({
    connectionString: host.getPostgresConnectionString(),
    queries: [buildDeleteNotificationsByDedupeKeyQuery(args)],
  });
}
