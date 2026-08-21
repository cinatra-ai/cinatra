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
 * DB-gated: self-skips unless a real SUPABASE_DB_URL is provided. Run with:
 *   SUPABASE_DB_URL='postgresql://dev:devpass@/devdb?host=/path/to/pgsock' \
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

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB =
  DB_URL !== "" && !DB_URL.includes("unused:unused@localhost:5432/unused");
const describeDb = HAS_DB ? describe : describe.skip;

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

beforeAll(async () => {
  if (!HAS_DB) return;
  admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${q(TEST_SCHEMA)}"`);
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
