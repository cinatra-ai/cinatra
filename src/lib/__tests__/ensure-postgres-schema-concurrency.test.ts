/**
 * Regression test: cold-boot Postgres timeout.
 *
 * Root cause: a per-thread in-memory globalThis flag by itself is insufficient
 * as a concurrency guard. At cold boot, multiple Turbopack compilation
 * worker_threads (all sharing the same process.pid) each independently saw the flag as
 * false and called runPostgresQueriesSync with the full 184-query DDL batch.
 * Postgres DDL lock contention serialized these concurrent workers at the DB level,
 * and with N threads each taking ~5 s the Nth thread's Atomics.wait(30 s) expired —
 * producing "Timed out while executing Postgres query."
 *
 * Fix contract (verified here):
 *   1. The first thread to call ensurePostgresSchema() atomically acquires a
 *      PID-scoped done-marker file
 *      (/tmp/cinatra-schema-init-<schema>-<pid>.done) AFTER a successful
 *      DDL run. An mtime freshness check at read time rejects stale
 *      markers from previous processes that recycled the PID.
 *   2. Concurrent threads in the same process that see the done-marker skip the
 *      DDL immediately (no Atomics.wait) and mark their per-thread flag.
 *   3. After the first full ensurePostgresSchema() call the done-marker exists on disk
 *      and subsequent threads (or the same thread after an HMR cycle) detect it and skip
 *      the DDL.
 *   4. The done-marker is PID-scoped + mtime-freshness-checked so it is
 *      automatically invalidated on server restart (new process = either
 *      different PID = different file path, or same recycled PID where the
 *      stale marker's mtime predates the new process's start epoch).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

// ---------------------------------------------------------------------------
// Module-level mocks — must come before the module under test is imported.
// ---------------------------------------------------------------------------

const mockRunPostgresQueriesSync = vi.fn(() => []);

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (_input: unknown) => { mockRunPostgresQueriesSync(); return []; },
  buildTruncateTableQuery: () => "",
  buildSelectAllQuery: () => "",
  buildDeleteAllQuery: () => "",
  quotePostgresIdentifier: (v: string) => `"${v}"`,
}));

vi.mock("@/lib/drizzle-store", () => ({
  buildCreateStoreSchemaQueries: () => [{ text: "CREATE SCHEMA IF NOT EXISTS cinatra" }],
  buildDeleteAllRowsQuery: () => ({ text: "DELETE FROM t" }),
  buildDeleteJsonRowQuery: () => ({ text: "DELETE FROM t WHERE id=$1" }),
  buildInsertJsonRowQuery: () => ({ text: "INSERT INTO t VALUES ($1, $2)" }),
  buildReadMetadataQuery: () => ({ text: "SELECT value FROM metadata WHERE key=$1" }),
  buildSelectJsonRowsQuery: () => ({ text: "SELECT * FROM t" }),
  buildUpsertJsonRowQuery: () => ({ text: "INSERT INTO t VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET payload=$2" }),
  buildWriteMetadataQuery: () => ({ text: "INSERT INTO metadata VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2" }),
}));

vi.mock("@/lib/runtime-mode", () => ({
  isAppDevelopmentMode: () => false,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns the done-marker file path for the default "cinatra" schema.
 * Mirrors the production formula in src/lib/database.ts:
 *   /tmp/cinatra-schema-init-<schema>-<pid>.done
 * No nonce — the production code uses PID alone for the filename and an
 * mtime freshness check (against PROCESS_START_EPOCH_MS) at read time to
 * reject stale markers left by crashed processes that recycled the PID.
 */
function sentinelPath(): string {
  return join(tmpdir(), `cinatra-schema-init-cinatra-${process.pid}.done`);
}

function clearSentinel(): void {
  try { rmSync(sentinelPath(), { force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensurePostgresSchema concurrency guard (cold-boot regression)", () => {
  beforeEach(() => {
    // Clear the per-thread in-memory flag so each test starts fresh.
    (globalThis as Record<string, unknown>).__cinatraPostgresSchemaInitialized = undefined;
    // Remove any sentinel file left from a previous test run in this process.
    clearSentinel();
    mockRunPostgresQueriesSync.mockClear();
    mockRunPostgresQueriesSync.mockImplementation(() => []);
  });

  afterEach(() => {
    clearSentinel();
  });

  it("calls runPostgresQueriesSync exactly once across repeated calls", async () => {
    // Simulate repeated calls from different async contexts (e.g. three concurrent
    // route handlers all reaching ensurePostgresSchema before the flag is set).
    // Because ensurePostgresSchema() is synchronous, the first call acquires the
    // sentinel and runs the DDL; the second and third see the sentinel and skip.

    const { ensurePostgresSchema } = await import("../database");

    ensurePostgresSchema(); // acquires sentinel, runs DDL
    ensurePostgresSchema(); // sees sentinel → skips
    ensurePostgresSchema(); // sees in-memory flag → skips immediately

    expect(mockRunPostgresQueriesSync).toHaveBeenCalledTimes(1);
  });

  it("writes the PID-scoped sentinel file after the DDL runs successfully", async () => {
    // The sentinel must persist on disk so other threads in the same process
    // (including threads created after the DDL completes) can detect it.

    const { ensurePostgresSchema } = await import("../database");

    ensurePostgresSchema();

    expect(existsSync(sentinelPath())).toBe(true);
  });

  it("skips the DDL and sets the in-memory flag when the done-marker already exists", async () => {
    // Simulate a second worker_thread in the same process starting up after the
    // first has already written the done-marker (post-DDL). The marker signals
    // that DDL was successfully completed.

    // Pre-write the done-marker as the prior successful run would have.
    writeFileSync(sentinelPath(), "1", "utf-8");

    const { ensurePostgresSchema } = await import("../database");

    ensurePostgresSchema();

    // DDL must NOT have been run — done-marker was present.
    expect(mockRunPostgresQueriesSync).toHaveBeenCalledTimes(0);

    // Per-thread flag must be set so subsequent calls are immediate no-ops.
    expect((globalThis as Record<string, unknown>).__cinatraPostgresSchemaInitialized).toBe(true);
  });

  it("does not write the done-marker after a failed DDL attempt, allowing retry", async () => {
    // The done-marker is written ONLY after runPostgresQueriesSync returns
    // successfully. If the DDL throws, the marker is never created, so future
    // calls retry the DDL (a clean cold-init from the caller's POV) rather
    // than silently skipping forever. This replaces the prior O_EXCL
    // "in-flight sentinel" design which had to explicitly unlink the
    // sentinel on failure.

    mockRunPostgresQueriesSync.mockImplementationOnce(() => {
      throw new Error("simulated DDL failure");
    });

    const { ensurePostgresSchema } = await import("../database");

    expect(() => ensurePostgresSchema()).toThrow("simulated DDL failure");

    // Done-marker must NOT exist (DDL failed → never marked done).
    expect(existsSync(sentinelPath())).toBe(false);

    // A subsequent call must retry the DDL (the failure sentinel was released).
    // Also clear the in-memory flag that may have been set partially.
    (globalThis as Record<string, unknown>).__cinatraPostgresSchemaInitialized = undefined;

    mockRunPostgresQueriesSync.mockImplementationOnce(() => []);
    ensurePostgresSchema();
    expect(mockRunPostgresQueriesSync).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale done-marker from a recycled PID and refreshes mtime after re-running DDL", async () => {
    // PID-recycling scenario: process A wrote a done-marker at /tmp/...<pid>.done
    // then died. This process (B) inherits the same PID — without the
    // mtime freshness check we'd silently skip DDL on a fresh DB. With
    // the check, B rejects the stale marker, re-runs idempotent DDL,
    // and CRITICALLY refreshes the marker's mtime so sibling worker_threads
    // in B then pass the fast-path freshness check on subsequent calls.
    // (An O_CREAT marker-set is a no-op for mtime on existing files; this
    // test guards the writeFileSync behavior.)

    const p = sentinelPath();
    // Plant a stale marker with mtime 1 hour ago.
    writeFileSync(p, "");
    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(p, oneHourAgo, oneHourAgo);
    const staleMtimeMs = statSync(p).mtimeMs;
    expect(staleMtimeMs).toBeLessThan(Date.now() - 60 * 1000); // sanity: > 1 minute old

    const { ensurePostgresSchema } = await import("../database");
    ensurePostgresSchema();

    // DDL must have run (stale marker was rejected by the freshness check).
    expect(mockRunPostgresQueriesSync).toHaveBeenCalledTimes(1);

    // Marker mtime must be REFRESHED so sibling threads now pass the
    // freshness check on the fast path.
    expect(existsSync(p)).toBe(true);
    const freshMtimeMs = statSync(p).mtimeMs;
    expect(freshMtimeMs).toBeGreaterThan(staleMtimeMs);
    expect(freshMtimeMs).toBeGreaterThanOrEqual(Date.now() - 5000); // refreshed within last 5s
  });
});
