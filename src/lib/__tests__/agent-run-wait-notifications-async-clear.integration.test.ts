/**
 * cinatra#2882 — the MIGRATED HOST CLEAR, against a real store and a real
 * event loop.
 *
 * `runWaitNotifier.onLeaveHumanWait` is the handler PR #2875's cancellation
 * trace found sitting on the synchronous bridge: an `async` method that reached
 * for a synchronous delete and therefore parked the whole process on
 * `Atomics.wait` for the length of one keyed DELETE. This suite drives that
 * handler for real — real notifications package, real seam, real Postgres, only
 * the run-row lookup stubbed — with the notifications table held under an
 * ACCESS EXCLUSIVE lock so the DELETE genuinely takes ~1s inside the database.
 *
 * The pin: a 150ms timer FIRES while the clear is still in flight, and the row
 * is gone when it returns. Point the handler back at
 * `deleteNotificationsByDedupeKeyForUser` (the synchronous twin, still exported
 * for genuinely synchronous hosts) and this goes red — the loop is frozen, so
 * the timer cannot run until the clear has already finished.
 *
 * The lock is released by Postgres itself (`idle_in_transaction_session_timeout`
 * on the blocking session), not by a client-side timer: a client-side release
 * could not fire on the frozen path, which is the very thing under test.
 *
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided — EXCEPT in
 * the dedicated lane, which refuses to skip (see the guard below). Run with:
 *   SUPABASE_DB_URL='<your scratch-database DSN>' \
 *     pnpm test:async-notification-seam
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const readAgentRunById = vi.fn<
  (id: string) => Promise<{
    id: string;
    runBy: string | null;
    title: string | null;
    status: string;
  } | null>
>();
const deriveRunHitlContext = vi.fn(async () => null);

// The notifier reaches the run store through this dynamic import. It is the ONE
// thing stubbed here: which run, and whose, is not what this suite is about.
vi.mock("@cinatra-ai/agents", () => ({ readAgentRunById, deriveRunHitlContext }));
// Host-adapter registration is a no-op — this suite registers its own adapters
// (carrying the REAL sync/async runners) against a throwaway schema below.
vi.mock("@/lib/notifications-host", () => ({}));

import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { runPostgresQueriesAsync } from "@/lib/postgres-async";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { setNotificationsHostAdapters } from "@cinatra-ai/notifications/server";
import type { NotificationsHostAdapters } from "@cinatra-ai/notifications/server";
import {
  runAwaitingHumanDedupeKey,
  runWaitNotifier,
} from "@/lib/agent-run-wait-notifications";
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

const TEST_SCHEMA = `cinatra_x2882c_${randomUUID().slice(0, 8)}`;
const q = (s: string) => s.replaceAll('"', '""');
const TABLE = `"${q(TEST_SCHEMA)}"."notifications"`;

const LOCK_HOLD_MS = 1200;
const TIMER_DUE_MS = 150;

const RUN_ID = "R-2882";
const USER_ID = "U-2882";

let admin: Client;

function registerAdapters(): void {
  const adapters: NotificationsHostAdapters = {
    getPostgresConnectionString: () => DB_URL,
    ensurePostgresSchema: () => {},
    postgresSchema: TEST_SCHEMA,
    runPostgresQueriesSync,
    runPostgresQueriesAsync,
    getAuthSession: async () => null,
    buildActorContext: async () => {
      throw new Error("not used in this suite");
    },
  };
  setNotificationsHostAdapters(adapters);
}

async function seedAwaitingHumanRow(): Promise<void> {
  await admin.query(`DELETE FROM ${TABLE}`);
  await admin.query(
    `INSERT INTO ${TABLE} (id, user_id, dedupe_key, kind, title, body)
     VALUES ($1, $2, $3, 'warning', 'awaiting you', 'open the run')`,
    ["n-awaiting", USER_ID, runAwaitingHumanDedupeKey(RUN_ID)],
  );
}

async function remainingIds(): Promise<string[]> {
  const res = await admin.query(`SELECT id FROM ${TABLE} ORDER BY id`);
  return res.rows.map((r: Record<string, unknown>) => String(r.id));
}

async function holdTableLock(): Promise<Client> {
  const blocker = new Client({ connectionString: DB_URL });
  // Postgres terminates this session to release the lock; that FATAL surfaces
  // asynchronously on the client and would otherwise be an uncaught exception.
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
  try {
    await blocker.end();
  } catch {
    /* already terminated by idle_in_transaction_session_timeout */
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

describeDb("cinatra#2882 onLeaveHumanWait clears without freezing the loop", () => {
  beforeEach(() => {
    readAgentRunById.mockReset();
    readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      runBy: USER_ID,
      title: "Nightly sync",
      status: "running",
    });
    registerAdapters();
  });

  it("a timer due mid-clear fires while the clear is still in flight", async () => {
    await seedAwaitingHumanRow();
    const blocker = await holdTableLock();

    const t0 = performance.now();
    let timerFiredAtMs = -1;
    const timer = setTimeout(() => {
      timerFiredAtMs = performance.now() - t0;
    }, TIMER_DUE_MS);

    await runWaitNotifier.onLeaveHumanWait!({ runId: RUN_ID });
    const clearReturnedAtMs = performance.now() - t0;

    clearTimeout(timer);
    await releaseBlocker(blocker);

    // The clear really did wait on the database — otherwise the timer beating
    // it says nothing about the event loop.
    expect(clearReturnedAtMs).toBeGreaterThan(LOCK_HOLD_MS * 0.5);
    expect(timerFiredAtMs).toBeGreaterThan(0);
    expect(timerFiredAtMs).toBeLessThan(clearReturnedAtMs);
    expect(timerFiredAtMs).toBeLessThan(LOCK_HOLD_MS * 0.5);

    // And it did the job: the awaiting-human row is gone.
    expect(await remainingIds()).toEqual([]);
  }, 60_000);

  it("still clears the right row by key, and spares an unrelated one", async () => {
    await seedAwaitingHumanRow();
    await admin.query(
      `INSERT INTO ${TABLE} (id, user_id, dedupe_key, kind, title, body)
       VALUES ($1, $2, $3, 'info', 'other', 'other')`,
      ["n-unrelated", USER_ID, "some-other-key"],
    );

    await runWaitNotifier.onLeaveHumanWait!({ runId: RUN_ID });

    expect(await remainingIds()).toEqual(["n-unrelated"]);
  });

  it("stays best-effort — a run with no initiator clears nothing and does not throw", async () => {
    await seedAwaitingHumanRow();
    readAgentRunById.mockResolvedValue({
      id: RUN_ID,
      runBy: null,
      title: "Nightly sync",
      status: "running",
    });

    await expect(
      runWaitNotifier.onLeaveHumanWait!({ runId: RUN_ID }),
    ).resolves.toBeUndefined();
    expect(await remainingIds()).toEqual(["n-awaiting"]);
  });
});
