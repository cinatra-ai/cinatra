/**
 * cinatra#2882 — REAL-Postgres proofs for the async notification-delete seam.
 *
 *   EQUIVALENCE   — `deleteNotificationsByDedupeKeyForUserAsync` and its
 *                   synchronous twin `deleteNotificationsByDedupeKeyForUser`
 *                   leave the SAME real store in the SAME state, from the same
 *                   starting rows, for the same key. Same guard, too: neither
 *                   touches another user's row on the same dedupe key, another
 *                   key on the same user, or anything at all when an argument
 *                   is empty.
 *
 *   EVENT LOOP    — THE POINT OF THE ISSUE. With the notifications table held
 *                   under an ACCESS EXCLUSIVE lock so the DELETE genuinely
 *                   takes ~1s inside Postgres:
 *                     • on the ASYNC path a 150ms timer fires WHILE the delete
 *                       is still in flight;
 *                     • on the SYNC path the same timer CANNOT fire until the
 *                       delete has returned — `Atomics.wait` froze the loop.
 *                   The contrast is the evidence; both halves run here.
 *
 *   THE CEILING    — a delete held behind a lock nobody releases REJECTS at the
 *                   seam's own bound and leaves the pool serviceable. The sync
 *                   bridge always settled (`Atomics.wait` times out); an async
 *                   seam with no ceiling would be strictly weaker — a promise
 *                   pending forever and a checkout never returned. The bound
 *                   that fires here is the CLIENT-side `query_timeout`, which
 *                   is the one that holds behind a connection pooler too.
 *
 *   NO SILENT FALLBACK
 *                 — a host that wires no async runner makes the seam THROW a
 *                   named error rather than quietly re-crossing the sync
 *                   bridge (which would put the freeze back under a name that
 *                   promises it is gone).
 *
 * The lock is released by Postgres itself (`idle_in_transaction_session_timeout`
 * on the blocking session), NOT by a client-side timer — a client-side release
 * could never fire during the sync half, because that is precisely the thing
 * the sync half prevents.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided — EXCEPT in
 * the dedicated lane, which refuses to skip (see the guard below). Run with:
 *   SUPABASE_DB_URL='<your scratch-database DSN>' \
 *     pnpm test:async-notification-seam
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  getPostgresAsyncPool,
  runPostgresQueriesAsync,
} from "@/lib/postgres-async";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  deleteNotificationsByDedupeKeyForUser,
  deleteNotificationsByDedupeKeyForUserAsync,
  deleteHoldNotificationForUser,
  deleteHoldNotificationForUserAsync,
  setNotificationsHostAdapters,
} from "@cinatra-ai/notifications/server";
import type { NotificationsHostAdapters } from "@cinatra-ai/notifications/server";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const describeDb = HAS_DB ? describe : describe.skip;

/**
 * REFUSE TO SKIP IN THE DEDICATED LANE (cinatra#2882).
 *
 * `describeDb` above is the right default everywhere else: a DB tier must not
 * red an ordinary unit run on a machine with no Postgres. But the dedicated
 * script exists for exactly one purpose, and a run whose only failure mode is
 * "skipped" reports success by doing nothing — a vacuous green over a seam
 * whose whole point is that it is provable. `vitest/integration/2882.config.ts`
 * sets the flag below, so `pnpm test:async-notification-seam` with no database
 * exits non-zero with a message naming the variable it wants. Set
 * `X2882_ALLOW_SKIP=1` to opt back into skipping (a deliberate no-DB smoke of
 * the config itself); every other config leaves the skip semantics untouched.
 */
const IN_DEDICATED_LANE =
  process.env.CINATRA_ASYNC_NOTIFICATION_SEAM_REALDB === "1";
const ALLOW_SKIP = process.env.X2882_ALLOW_SKIP === "1";

if (IN_DEDICATED_LANE && !ALLOW_SKIP && !HAS_DB) {
  throw new Error(
    "the #2882 async notification-seam lane needs a live Postgres: set " +
      "SUPABASE_DB_URL to a real connection string (it is unset, empty, or the " +
      "unused:unused placeholder). Refusing to skip — a skipped proof of an " +
      "async seam proves nothing. Pass X2882_ALLOW_SKIP=1 to skip anyway.",
  );
}

const TEST_SCHEMA = `cinatra_x2882_${randomUUID().slice(0, 8)}`;
const q = (s: string) => s.replaceAll('"', '""');
const TABLE = `"${q(TEST_SCHEMA)}"."notifications"`;

// How long the blocking session holds ACCESS EXCLUSIVE before Postgres kills it,
// and when the observer timer is due. The gap between them is the whole test:
// 150ms is comfortably inside the ~1200ms the delete spends waiting on the lock,
// so a timer that fires "during" is unambiguous and one that cannot is too.
const LOCK_HOLD_MS = 1200;
const TIMER_DUE_MS = 150;

// The seam's own ceiling, as the dedicated config sets it (4000ms — the 30s
// production default shrunk so it is provable inside a test run). Read from the
// environment rather than restated, so the config and this suite cannot drift.
const BOUND_MS = (() => {
  const raw = Number(process.env.POSTGRES_ASYNC_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
})();

let admin: Client;

/** Register adapters carrying the REAL runners against the throwaway schema. */
function registerAdapters(opts?: { withAsyncRunner?: boolean }): void {
  const adapters: NotificationsHostAdapters = {
    getPostgresConnectionString: () => DB_URL,
    // The real one is a globalThis/marker-cached no-op after the single cold
    // init per process; this suite builds its own schema in beforeAll, so the
    // faithful stand-in is the no-op it becomes.
    ensurePostgresSchema: () => {},
    postgresSchema: TEST_SCHEMA,
    runPostgresQueriesSync,
    getAuthSession: async () => null,
    buildActorContext: async () => {
      throw new Error("not used in this suite");
    },
    ...(opts?.withAsyncRunner === false ? {} : { runPostgresQueriesAsync }),
  };
  setNotificationsHostAdapters(adapters);
}

// `hold_park_id` is written into the row's metadata under the key the hold
// delete narrows on (`metadata -> 'runAwaitingHuman' ->> 'holdParkId'`) —
// cinatra#2835 stamps it, and no other writer sets it. Absent here means a row
// no hold may ever delete, which is exactly what the narrowing has to prove.
type Row = {
  id: string;
  user_id: string;
  dedupe_key: string;
  hold_park_id?: string;
};

async function seed(rows: Row[]): Promise<void> {
  await admin.query(`DELETE FROM ${TABLE}`);
  for (const r of rows) {
    await admin.query(
      `INSERT INTO ${TABLE} (id, user_id, dedupe_key, kind, title, body, metadata)
       VALUES ($1, $2, $3, 'info', 'x', 'y', $4::jsonb)`,
      [
        r.id,
        r.user_id,
        r.dedupe_key,
        JSON.stringify(
          r.hold_park_id
            ? { runAwaitingHuman: { runId: "r1", holdParkId: r.hold_park_id } }
            : { runAwaitingHuman: { runId: "r1" } },
        ),
      ],
    );
  }
}

async function snapshot(): Promise<string[]> {
  const res = await admin.query(
    `SELECT id, user_id, dedupe_key FROM ${TABLE} ORDER BY id`,
  );
  return res.rows.map(
    (r: Record<string, unknown>) => `${r.id}|${r.user_id}|${r.dedupe_key}`,
  );
}

/**
 * Hold ACCESS EXCLUSIVE on the notifications table from a SEPARATE session, and
 * let POSTGRES release it after `LOCK_HOLD_MS` by killing that session for being
 * idle in a transaction. Server-side on purpose: a client-side `setTimeout`
 * release would never run during the sync half.
 */
async function holdTableLock(holdMs: number = LOCK_HOLD_MS): Promise<Client> {
  const blocker = new Client({ connectionString: DB_URL });
  // Postgres TERMINATES this session to release the lock (that is the point),
  // which surfaces on the client as an async FATAL 25P03 / "Connection
  // terminated unexpectedly". Node treats an unhandled 'error' on a pg Client
  // as an uncaught exception, so absorb it here: it is the expected end of this
  // connection's life, not a failure.
  blocker.on("error", () => {});
  await blocker.connect();
  await blocker.query(
    `SET idle_in_transaction_session_timeout = '${holdMs}ms'`,
  );
  await blocker.query("BEGIN");
  await blocker.query(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE`);
  return blocker;
}

async function releaseBlocker(blocker: Client): Promise<void> {
  // Already terminated by Postgres in the happy path; end() is the cleanup for
  // the case where the delete finished first.
  try {
    await blocker.end();
  } catch {
    /* session already terminated by idle_in_transaction_session_timeout */
  }
}

/** Let any timer whose deadline has passed actually run before we read it. */
function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Poll `predicate` until it holds, or give up after ~2s and let the caller's
 * assertion report the failure. Destroying a pooled client ends its socket and
 * Postgres drops the backend from `pg_stat_activity` when it notices — two
 * asynchronous steps, so the reading has to be settled rather than snatched.
 */
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * The statements from the canonical bootstrap that build the NOTIFICATIONS
 * table — its typed columns, its partial unique dedupe index, and the realtime
 * NOTIFY trigger plus the function it calls. Taken from the bootstrap rather
 * than hand-written, so this suite runs against the constraints production has;
 * the other ~170 statements build tables it never touches.
 *
 * SELECTED BY OBJECT, NOT BY THE WORD "notification" (cinatra#2882 + #2838).
 * The original filter was `/notification/i` over the statement text, which is a
 * different question from "does this statement build the notifications table"
 * and stopped agreeing with it the moment another table grew a column with
 * `notification` in its name. #2838 added exactly that — three statements over
 * `lifecycle_continuation_park` for its `hold_notification` state — and because
 * they ALTER a table this schema deliberately never creates, the whole
 * `beforeAll` died on "relation ... does not exist" and every arm reported as
 * skipped. (A fourth false positive, `agent_creation_request`, had been matching
 * all along; it is a self-contained CREATE TABLE, so it merely built a table
 * nobody wanted, silently.)
 *
 * So match the OBJECTS: the schema-qualified table, and the trigger function by
 * name (its CREATE mentions no table). Anything that only talks ABOUT
 * notifications is not part of this schema.
 */
function notificationSchemaQueries(schema: string): Array<{ text: string }> {
  const needle = new RegExp(
    `"${schema.replaceAll('"', '""')}"\\."notifications"|fn_notify_notification_insert`,
  );
  const queries = buildCreateStoreSchemaQueries(schema).filter((s) =>
    needle.test(s.text),
  );
  // A silent empty selection would leave an empty schema and turn every arm into
  // a confusing "relation does not exist" far from the cause. Fail at the cause.
  if (!queries.some((s) => /CREATE TABLE[^;]*"notifications"/i.test(s.text))) {
    throw new Error(
      "the notifications DDL was not found in buildCreateStoreSchemaQueries() — " +
        "the table or the trigger function was probably renamed. Update the " +
        "object names this suite selects on.",
    );
  }
  return queries;
}

beforeAll(async () => {
  if (!HAS_DB) return;
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${q(TEST_SCHEMA)}"`);
  for (const stmt of notificationSchemaQueries(TEST_SCHEMA)) {
    await admin.query(stmt.text);
  }
  registerAdapters();
}, 120_000);

afterAll(async () => {
  if (!HAS_DB) return;
  await admin.query(`DROP SCHEMA IF EXISTS "${q(TEST_SCHEMA)}" CASCADE`);
  await admin.end();
});

describeDb("cinatra#2882 async notification-delete seam", () => {
  beforeEach(() => {
    registerAdapters();
  });

  describe("equivalence with the synchronous twin", () => {
    const START: Row[] = [
      { id: "n-target", user_id: "user-a", dedupe_key: "run-awaiting:r1" },
      // Same key, DIFFERENT user — the per-user scope must spare it.
      { id: "n-other-user", user_id: "user-b", dedupe_key: "run-awaiting:r1" },
      // Same user, DIFFERENT key — the key scope must spare it.
      { id: "n-other-key", user_id: "user-a", dedupe_key: "run-awaiting:r2" },
    ];

    it("leaves the same store state as the sync path, from the same rows", async () => {
      await seed(START);
      deleteNotificationsByDedupeKeyForUser({
        userId: "user-a",
        dedupeKey: "run-awaiting:r1",
      });
      const afterSync = await snapshot();

      await seed(START);
      await deleteNotificationsByDedupeKeyForUserAsync({
        userId: "user-a",
        dedupeKey: "run-awaiting:r1",
      });
      const afterAsync = await snapshot();

      expect(afterAsync).toEqual(afterSync);
      // ...and that shared state is the RIGHT one: the keyed row is gone, both
      // neighbours survive. (Equality alone would also be satisfied by two
      // paths that each did nothing.)
      expect(afterSync).toEqual([
        "n-other-key|user-a|run-awaiting:r2",
        "n-other-user|user-b|run-awaiting:r1",
      ]);
    });

    it("is idempotent on both paths — a key that names no row is a no-op", async () => {
      await seed(START);
      const before = await snapshot();
      deleteNotificationsByDedupeKeyForUser({
        userId: "user-a",
        dedupeKey: "no-such-key",
      });
      await deleteNotificationsByDedupeKeyForUserAsync({
        userId: "user-a",
        dedupeKey: "no-such-key",
      });
      expect(await snapshot()).toEqual(before);
    });

    it("guards an empty userId / dedupeKey identically — neither issues a query", async () => {
      await seed(START);
      const before = await snapshot();
      for (const args of [
        { userId: "", dedupeKey: "run-awaiting:r1" },
        { userId: "user-a", dedupeKey: "" },
      ]) {
        deleteNotificationsByDedupeKeyForUser(args);
        await deleteNotificationsByDedupeKeyForUserAsync(args);
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  // cinatra#2838 brought a SECOND production clear onto this seam: the run-start
  // recommendation hold's, which narrows the same per-run key by the park id the
  // row carries. It is a different statement with a different guard, so it gets
  // its own equivalence proof rather than riding on the one above.
  describe("equivalence with the synchronous twin — the HOLD-scoped clear", () => {
    const KEY = "run-awaiting:r1";
    // Same key AND same park id, different user — the per-user scope spares it,
    // and the partial unique index permits it because that index is per-user.
    const OTHER_USER: Row = {
      id: "n-other-user",
      user_id: "user-b",
      dedupe_key: KEY,
      hold_park_id: "park-7",
    };

    // ONE OCCUPANT AT A TIME, which is the whole reason the narrowing exists.
    // `notifications_dedupe_key_idx` is UNIQUE on `(user_id, dedupe_key)`, so
    // user-a holds at most one row on this run's key — the hold's own row, or
    // whatever took the key after that hold ended. A clear retried by a later
    // sweep cannot know which it will find, so these are separate seeds rather
    // than one crowded fixture: each is a state the retry can genuinely arrive in.
    const CASES: Array<{ what: string; occupant: Row; deleted: boolean }> = [
      {
        what: "the hold's OWN row",
        occupant: { id: "n-hold", user_id: "user-a", dedupe_key: KEY, hold_park_id: "park-7" },
        deleted: true,
      },
      {
        what: "a LATER hold's row on the same key",
        occupant: { id: "n-hold-8", user_id: "user-a", dedupe_key: KEY, hold_park_id: "park-8" },
        deleted: false,
      },
      {
        what: "the plain wait that took the key after this hold ended",
        occupant: { id: "n-plain-wait", user_id: "user-a", dedupe_key: KEY },
        deleted: false,
      },
    ];

    for (const c of CASES) {
      it(`leaves the same store state as the sync path — ${c.what}`, async () => {
        const rows = [c.occupant, OTHER_USER];
        const args = { userId: "user-a", dedupeKey: KEY, holdParkId: "park-7" };

        await seed(rows);
        expect(deleteHoldNotificationForUser(args)).toBe(true);
        const afterSync = await snapshot();

        await seed(rows);
        await expect(deleteHoldNotificationForUserAsync(args)).resolves.toBe(true);
        const afterAsync = await snapshot();

        expect(afterAsync).toEqual(afterSync);
        // ...and that shared state is the RIGHT one. Equality alone would also be
        // satisfied by two paths that each deleted the whole key, or each did
        // nothing, so name the surviving rows outright.
        const survivors = [
          ...(c.deleted ? [] : [`${c.occupant.id}|user-a|${KEY}`]),
          `n-other-user|user-b|${KEY}`,
        ].sort();
        expect(afterSync).toEqual(survivors);
      });
    }

    it("acks a park that names no row, on both paths, without touching the store", async () => {
      // The ack is "the statement COMMITTED", not "a row matched" — a clear
      // retried after its row is already gone HAS discharged its obligation, and
      // reporting `false` there would make the sweep retry it forever.
      await seed([CASES[0].occupant, OTHER_USER]);
      const before = await snapshot();
      const args = { userId: "user-a", dedupeKey: KEY, holdParkId: "park-never-existed" };
      expect(deleteHoldNotificationForUser(args)).toBe(true);
      await expect(deleteHoldNotificationForUserAsync(args)).resolves.toBe(true);
      expect(await snapshot()).toEqual(before);
    });

    it("guards a missing id identically — neither issues a query, and neither acks", async () => {
      // A NON-ack here, unlike above: nothing was asked of the database, so
      // nothing was discharged. Both twins must agree on that, or a sweep would
      // retire an obligation on the strength of an argument it never sent.
      await seed([CASES[0].occupant, OTHER_USER]);
      const before = await snapshot();
      for (const args of [
        { userId: "", dedupeKey: KEY, holdParkId: "park-7" },
        { userId: "user-a", dedupeKey: "", holdParkId: "park-7" },
        { userId: "user-a", dedupeKey: KEY, holdParkId: "" },
      ]) {
        expect(deleteHoldNotificationForUser(args)).toBe(false);
        await expect(deleteHoldNotificationForUserAsync(args)).resolves.toBe(false);
      }
      expect(await snapshot()).toEqual(before);
    });
  });

  describe("the event loop during an in-flight slow delete", () => {
    it("ASYNC: a timer due mid-delete fires while the delete is still running", async () => {
      await seed([
        { id: "n-slow-a", user_id: "user-a", dedupe_key: "slow:async" },
      ]);
      const blocker = await holdTableLock();

      const t0 = performance.now();
      let timerFiredAtMs = -1;
      const timer = setTimeout(() => {
        timerFiredAtMs = performance.now() - t0;
      }, TIMER_DUE_MS);

      await deleteNotificationsByDedupeKeyForUserAsync({
        userId: "user-a",
        dedupeKey: "slow:async",
      });
      const deleteReturnedAtMs = performance.now() - t0;

      clearTimeout(timer);
      await releaseBlocker(blocker);

      // The delete really was slow — otherwise the timer beating it proves
      // nothing about the event loop.
      expect(deleteReturnedAtMs).toBeGreaterThan(LOCK_HOLD_MS * 0.5);
      // The timer ran, roughly on time, and strictly before the delete resolved.
      expect(timerFiredAtMs).toBeGreaterThan(0);
      expect(timerFiredAtMs).toBeLessThan(deleteReturnedAtMs);
      expect(timerFiredAtMs).toBeLessThan(LOCK_HOLD_MS * 0.5);

      expect(await snapshot()).toEqual([]);
    }, 60_000);

    it("SYNC: the same timer cannot fire until the delete has returned", async () => {
      await seed([
        { id: "n-slow-s", user_id: "user-a", dedupe_key: "slow:sync" },
      ]);
      const blocker = await holdTableLock();

      const t0 = performance.now();
      let timerFiredAtMs = -1;
      setTimeout(() => {
        timerFiredAtMs = performance.now() - t0;
      }, TIMER_DUE_MS);

      deleteNotificationsByDedupeKeyForUser({
        userId: "user-a",
        dedupeKey: "slow:sync",
      });
      const deleteReturnedAtMs = performance.now() - t0;

      // Nothing can have run yet: this thread has been inside Atomics.wait for
      // the whole window, so the 150ms timer is still pending at 1200ms.
      expect(timerFiredAtMs).toBe(-1);

      await flushTimers();
      await releaseBlocker(blocker);

      expect(deleteReturnedAtMs).toBeGreaterThan(LOCK_HOLD_MS * 0.5);
      // It fired only once the loop was given back — long past its deadline.
      expect(timerFiredAtMs).toBeGreaterThanOrEqual(deleteReturnedAtMs);
      expect(timerFiredAtMs).toBeGreaterThan(TIMER_DUE_MS * 4);

      expect(await snapshot()).toEqual([]);
    }, 60_000);
  });


  describe("the seam's own ceiling", () => {
    /**
     * THE SETTLE GUARANTEE. The sync bridge this seam replaced always settled —
     * `Atomics.wait` returns "timed-out" and the caller gets a throw. The first
     * cut of the async seam set no ceiling at all, so a delete behind a lock
     * nobody releases left the handler's promise pending FOREVER and never gave
     * its client back. The five migrated clears each absorb their own failure
     * by design — four swallow it, #2838's hold clear turns it into a non-ack —
     * so that leak would have been permanent and silent in all of them.
     *
     * Here the lock is held far past the ceiling and never released on its own.
     * The delete must REJECT (ordinarily — the caller's best-effort catch takes
     * it), at roughly the ceiling, and the pool must come out serviceable.
     *
     * WHICH BOUND FIRES, and why the assertion names it. The migrated clear is
     * a single autocommit statement (no `transaction: true`), so the only bound
     * on it is the CLIENT-side `query_timeout` — deliberately so: the
     * server-side `statement_timeout` was removed from the pool config because
     * pg sends that as a STARTUP PARAMETER, which a PgBouncer/Supavisor-class
     * pooler rejects outright (see `postgres-async-pool-config.test.ts`). The
     * expected message is therefore pg's own `Query read timeout`, asserted
     * exactly rather than as an alternation — accepting a `statement timeout`
     * message here would let the startup-parameter form pass this pin.
     *
     * That path DESTROYS the client rather than returning it (pg's stream is
     * desynced once it abandons a query), which is why the pool assertions
     * below are about a pool that is EMPTY of checkouts and still usable, not
     * about the same connection coming home.
     */
    it("a delete blocked past the bound rejects, and leaves the pool serviceable", async () => {
      await seed([{ id: "n-bounded", user_id: "user-a", dedupe_key: "bounded" }]);
      const pool = getPostgresAsyncPool(DB_URL);
      // Put the pool in a KNOWN state — one warm idle client, nothing checked
      // out — immediately before the measurement, so "the timed-out client was
      // destroyed, not returned" is a deterministic reading rather than a
      // guess about what earlier tests left behind (pg reaps idle clients after
      // `idleTimeoutMillis`, so this must be fresh).
      await runPostgresQueriesAsync({
        connectionString: DB_URL,
        queries: [{ text: "SELECT 1" }],
      });
      const idleBefore = pool.idleCount;
      const checkedOutBefore = pool.totalCount - pool.idleCount;
      expect(idleBefore).toBeGreaterThan(0);
      expect(checkedOutBefore).toBe(0);

      // Ten ceilings of hold: long enough that nothing here can be explained by
      // the lock lapsing, short enough to be a safety net if this test throws.
      const blocker = await holdTableLock(BOUND_MS * 10);

      const t0 = performance.now();
      // Raced against a watchdog ON PURPOSE: with the ceiling removed this must
      // fail as a bounded assertion that says what happened, not as a test that
      // hangs until the runner's timeout kills it.
      const outcome = await Promise.race([
        deleteNotificationsByDedupeKeyForUserAsync({
          userId: "user-a",
          dedupeKey: "bounded",
        })
          .then(() => "resolved-without-waiting" as const)
          .catch((error: unknown) => error),
        new Promise<"never-settled">((resolve) =>
          setTimeout(() => resolve("never-settled"), BOUND_MS * 3),
        ),
      ]);
      const elapsedMs = performance.now() - t0;

      await releaseBlocker(blocker);

      // Settled at all — this is the assertion the unbounded seam fails.
      expect(outcome).not.toBe("never-settled");
      // ...as an ordinary rejection, not a silent success.
      expect(outcome).toBeInstanceOf(Error);
      // pg's own message for an expired `query_timeout`. Named exactly: the
      // startup-parameter form this seam must never go back to would fail here
      // with "canceling statement due to statement timeout" instead.
      expect((outcome as Error).message).toBe("Query read timeout");
      // It really did wait for the ceiling rather than failing fast for an
      // unrelated reason, and it did not wait appreciably past it.
      expect(elapsedMs).toBeGreaterThan(BOUND_MS * 0.5);
      expect(elapsedMs).toBeLessThan(BOUND_MS * 3);

      // THE LEAK PIN: the checkout was given back. An unbounded call holds it
      // for the life of the process, so `max` of them wedge every later caller
      // of this pool.
      expect(pool.totalCount - pool.idleCount).toBe(checkedOutBefore);
      expect(pool.waitingCount).toBe(0);
      // ...and given back by being DESTROYED, not returned to the idle set: a
      // client whose query pg abandoned has a desynced protocol stream, and the
      // reply to that abandoned statement would land on whoever checked it out
      // next. A clean release would have left `idleCount` unchanged.
      expect(pool.idleCount).toBe(idleBefore - 1);

      // And the pool is still serviceable: the same seam, same key, now that
      // the lock is gone.
      await deleteNotificationsByDedupeKeyForUserAsync({
        userId: "user-a",
        dedupeKey: "bounded",
      });
      expect(await snapshot()).toEqual([]);
    }, 120_000);

    /**
     * THE OTHER HALF OF THE CEILING: the transaction path's server-side cancel.
     *
     * `SET LOCAL statement_timeout`, issued with the BEGIN, is the pooler-SAFE
     * form of the bound the pool config must not carry — transaction-scoped, so
     * it is reverted at COMMIT/ROLLBACK and can never become session state on a
     * pooled server connection. This pin is what makes keeping it worth the
     * extra statement: unlike the client-side read timeout, Postgres actually
     * CANCELS the blocked statement (57014) instead of abandoning it while the
     * backend keeps waiting on the lock, and the connection survives to be
     * reused rather than being destroyed.
     */
    it("TRANSACTION path: the server cancels the statement, and the client survives", async () => {
      await seed([{ id: "n-txn", user_id: "user-a", dedupe_key: "txn" }]);
      const pool = getPostgresAsyncPool(DB_URL);
      // Same known-pool-state setup as above, for the same reason.
      await runPostgresQueriesAsync({
        connectionString: DB_URL,
        queries: [{ text: "SELECT 1" }],
      });
      const idleBefore = pool.idleCount;
      expect(idleBefore).toBeGreaterThan(0);

      const blocker = await holdTableLock(BOUND_MS * 10);
      const t0 = performance.now();
      const outcome = await Promise.race([
        runPostgresQueriesAsync({
          connectionString: DB_URL,
          transaction: true,
          queries: [
            {
              text: `DELETE FROM ${TABLE} WHERE user_id = $1 AND dedupe_key = $2`,
              values: ["user-a", "txn"],
            },
          ],
        })
          .then(() => "resolved-without-waiting" as const)
          .catch((error: unknown) => error),
        new Promise<"never-settled">((resolve) =>
          setTimeout(() => resolve("never-settled"), BOUND_MS * 3),
        ),
      ]);
      const elapsedMs = performance.now() - t0;
      await releaseBlocker(blocker);

      expect(outcome).not.toBe("never-settled");
      expect(outcome).toBeInstanceOf(Error);
      // Postgres cancelled it — NOT pg abandoning the read. This is the whole
      // difference the transaction path buys.
      expect((outcome as { code?: string }).code).toBe("57014");
      expect((outcome as Error).message).toMatch(/statement timeout/i);
      // It fired at the server-side bound, which sits strictly UNDER the
      // client-side read timeout so the clean cancel wins the race.
      expect(elapsedMs).toBeGreaterThan(BOUND_MS * 0.5);
      expect(elapsedMs).toBeLessThan(BOUND_MS);

      // The client came back ALIVE: rolled back and returned to the idle set,
      // not destroyed. (The read-timeout path above decrements `idleCount`.)
      expect(pool.totalCount - pool.idleCount).toBe(0);
      expect(pool.idleCount).toBe(idleBefore);
      expect(pool.waitingCount).toBe(0);

      // Rolled back, so the row is still there — and the pool still works.
      expect(await snapshot()).toEqual(["n-txn|user-a|txn"]);
      await deleteNotificationsByDedupeKeyForUserAsync({
        userId: "user-a",
        dedupeKey: "txn",
      });
      expect(await snapshot()).toEqual([]);
    }, 120_000);
  });

  /**
   * cinatra#2882 round 1 — a ROLLBACK that FAILS must destroy its client.
   *
   * On the transaction path a caller-query failure is followed by a best-effort
   * ROLLBACK, caught so a rollback error cannot mask the caller's. "Do not mask
   * it" was implemented as "ignore it": `release()` then ran with no argument
   * and the client went back to the idle set — with its transaction still OPEN,
   * holding whatever locks it had taken, and (when the rollback failed by
   * blowing `query_timeout`) with pg's protocol stream desynced too.
   *
   * WHY THE ROLLBACK'S FAILURE IS INJECTED HERE and nothing else is. A ROLLBACK
   * cannot be made to fail against a live Postgres on cue: it takes no locks and
   * returns in microseconds, so no timeout reaches it, and the one thing that
   * does fail it — killing the backend — takes the socket with it, which pg
   * surfaces as an `'error'` event on a CHECKED-OUT client. The pool removes its
   * own listener at checkout (`pg-pool`), so that event has no handler and Node
   * turns it into an uncaught exception that kills the runner before any
   * assertion runs. (Verified against pg 8.22.0; it is the same hazard the
   * `holdTableLock` helper above absorbs with an explicit listener on a client
   * it owns.)
   *
   * So exactly ONE thing is faked — the ROLLBACK's answer, and with the precise
   * error pg raises when `query_timeout` fires. Everything else is real: a real
   * BEGIN with its real `SET LOCAL`, a real DELETE against real rows, a real
   * Postgres error (22012) to enter the catch, a real pool, and a real backend
   * left holding a real open transaction. That last part is the point — the
   * assertions below are the ones the unit tier CANNOT make, because they are
   * about what the server sees.
   */
  describe("a ROLLBACK that fails", () => {
    /** Fail ONLY the ROLLBACK on the next checkout, as a pg read timeout. */
    function failNextRollback(pool: ReturnType<typeof getPostgresAsyncPool>): {
      restore: () => void;
      readonly rollbackError: Error | undefined;
    } {
      const realConnect = pool.connect.bind(pool);
      const state: { rollbackError: Error | undefined } = {
        rollbackError: undefined,
      };
      Object.assign(pool, {
        connect: async () => {
          const client = await realConnect();
          const realQuery = client.query.bind(client);
          Object.assign(client, {
            query: (...args: unknown[]) => {
              const first = args[0];
              const text =
                typeof first === "string"
                  ? first
                  : (first as { text?: string } | undefined)?.text;
              if (text === "ROLLBACK") {
                // pg's own message when `query_timeout` expires — the shape
                // this takes in production, where the server that failed the
                // caller's statement is also the one not answering this one.
                state.rollbackError = new Error("Query read timeout");
                return Promise.reject(state.rollbackError);
              }
              return (realQuery as (...a: unknown[]) => unknown)(...args);
            },
          });
          return client;
        },
      });
      return {
        restore: () => Object.assign(pool, { connect: realConnect }),
        get rollbackError() {
          return state.rollbackError;
        },
      };
    }

    /** Backends of THIS database sitting in an open transaction, right now. */
    async function idleInTransactionCount(): Promise<number> {
      const res = await admin.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND state = 'idle in transaction'`,
      );
      return (res.rows[0] as { n: number }).n;
    }

    it("destroys the client, so the open transaction dies with it", async () => {
      await seed([
        { id: "n-rollback", user_id: "user-a", dedupe_key: "rollback" },
      ]);
      const pool = getPostgresAsyncPool(DB_URL);
      // Same known-pool-state setup as the ceiling pins above, for the same
      // reason: "the client was destroyed, not returned" has to be a reading,
      // not a guess about what earlier tests left behind.
      await runPostgresQueriesAsync({
        connectionString: DB_URL,
        queries: [{ text: "SELECT 1" }],
      });
      const idleBefore = pool.idleCount;
      expect(idleBefore).toBeGreaterThan(0);
      expect(pool.totalCount - pool.idleCount).toBe(0);
      expect(await idleInTransactionCount()).toBe(0);

      const injected = failNextRollback(pool);
      let outcome: unknown;
      try {
        outcome = await runPostgresQueriesAsync({
          connectionString: DB_URL,
          transaction: true,
          queries: [
            {
              text: `DELETE FROM ${TABLE} WHERE user_id = $1 AND dedupe_key = $2`,
              values: ["user-a", "rollback"],
            },
            // A REAL Postgres error, on a connection that stays healthy: this
            // is what puts the run into the catch with an open transaction to
            // close, which is the situation the fix is about.
            { text: "SELECT 1 / 0" },
          ],
        })
          .then(() => "resolved" as const)
          .catch((error: unknown) => error);
      } finally {
        injected.restore();
      }

      // The CALLER's error is what surfaced — the rollback failure did not mask
      // it, which is the property the original `catch {}` was protecting.
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as { code?: string }).code).toBe("22012");
      // ...and the rollback really was attempted and really did fail.
      expect(injected.rollbackError).toBeInstanceOf(Error);

      // THE PIN. The client was released with a truthy argument, so the pool
      // DESTROYED it instead of pooling it: closing the socket is what aborts
      // the transaction the failed ROLLBACK could not. Before the fix this
      // read 1 — a backend parked `idle in transaction`, reachable by the next
      // caller who checked that client out.
      await waitFor(async () => (await idleInTransactionCount()) === 0);
      expect(await idleInTransactionCount()).toBe(0);
      // ...and the pool agrees: the checkout came back, by being dropped.
      expect(pool.totalCount - pool.idleCount).toBe(0);
      expect(pool.idleCount).toBe(idleBefore - 1);
      expect(pool.waitingCount).toBe(0);

      // The DELETE never took effect — the transaction aborted, as it must.
      expect(await snapshot()).toEqual(["n-rollback|user-a|rollback"]);

      // And the pool is still serviceable on a fresh connection.
      await deleteNotificationsByDedupeKeyForUserAsync({
        userId: "user-a",
        dedupeKey: "rollback",
      });
      expect(await snapshot()).toEqual([]);
    }, 120_000);
  });

  describe("a host that wires no async runner", () => {
    it("throws a named error instead of silently crossing the sync bridge", async () => {
      await seed([
        { id: "n-nofallback", user_id: "user-a", dedupe_key: "nofallback" },
      ]);
      registerAdapters({ withAsyncRunner: false });

      await expect(
        deleteNotificationsByDedupeKeyForUserAsync({
          userId: "user-a",
          dedupeKey: "nofallback",
        }),
      ).rejects.toThrow(/runPostgresQueriesAsync/);

      // No fallback happened: the row is untouched.
      expect(await snapshot()).toEqual(["n-nofallback|user-a|nofallback"]);
    });
  });
});
