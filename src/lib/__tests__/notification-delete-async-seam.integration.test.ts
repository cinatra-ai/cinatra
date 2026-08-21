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
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL='postgresql://dev:devpass@/devdb?host=/path/to/pgsock' \
 *     pnpm test:async-notification-seam
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { runPostgresQueriesAsync } from "@/lib/postgres-async";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  deleteNotificationsByDedupeKeyForUser,
  deleteNotificationsByDedupeKeyForUserAsync,
  setNotificationsHostAdapters,
} from "@cinatra-ai/notifications/server";
import type { NotificationsHostAdapters } from "@cinatra-ai/notifications/server";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const describeDb = HAS_DB ? describe : describe.skip;

const TEST_SCHEMA = `cinatra_x2882_${randomUUID().slice(0, 8)}`;
const q = (s: string) => s.replaceAll('"', '""');
const TABLE = `"${q(TEST_SCHEMA)}"."notifications"`;

// How long the blocking session holds ACCESS EXCLUSIVE before Postgres kills it,
// and when the observer timer is due. The gap between them is the whole test:
// 150ms is comfortably inside the ~1200ms the delete spends waiting on the lock,
// so a timer that fires "during" is unambiguous and one that cannot is too.
const LOCK_HOLD_MS = 1200;
const TIMER_DUE_MS = 150;

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

type Row = { id: string; user_id: string; dedupe_key: string };

async function seed(rows: Row[]): Promise<void> {
  await admin.query(`DELETE FROM ${TABLE}`);
  for (const r of rows) {
    await admin.query(
      `INSERT INTO ${TABLE} (id, user_id, dedupe_key, kind, title, body)
       VALUES ($1, $2, $3, 'info', 'x', 'y')`,
      [r.id, r.user_id, r.dedupe_key],
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
async function holdTableLock(): Promise<Client> {
  const blocker = new Client({ connectionString: DB_URL });
  // Postgres TERMINATES this session to release the lock (that is the point),
  // which surfaces on the client as an async FATAL 25P03 / "Connection
  // terminated unexpectedly". Node treats an unhandled 'error' on a pg Client
  // as an uncaught exception, so absorb it here: it is the expected end of this
  // connection's life, not a failure.
  blocker.on("error", () => {});
  await blocker.connect();
  await blocker.query(
    `SET idle_in_transaction_session_timeout = '${LOCK_HOLD_MS}ms'`,
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

beforeAll(async () => {
  if (!HAS_DB) return;
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${q(TEST_SCHEMA)}"`);
  // The REAL notifications DDL (table + typed columns + the partial unique
  // dedupe index + the realtime NOTIFY trigger and the function it calls),
  // taken from the canonical bootstrap rather than hand-written, so the delete
  // runs against the constraints production has. Only the notification
  // statements are needed here; the other ~170 build tables this suite never
  // touches.
  for (const stmt of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    if (!/notification/i.test(stmt.text)) continue;
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
