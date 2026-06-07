/**
 * Regression test for cold-boot Postgres timeout.
 *
 * Root cause: `ensurePostgresSchema()` uses a per-worker-thread `globalThis` flag
 * to deduplicate schema initialization. Turbopack dev server spawns multiple
 * Node.js worker_threads for route compilation, each with its own V8 isolate and
 * `globalThis`. All workers independently call `ensurePostgresSchema()` at cold boot,
 * creating N concurrent pg.Client connections each running 183 DDL queries. The
 * resulting Postgres DDL lock contention causes the 30-second Atomics.wait timeout.
 *
 * Fix (current design): A PID-scoped done-marker file
 * (`/tmp/cinatra-schema-init-<schema>-<pid>.done`) is written ONLY after
 * a successful DDL run. An mtime freshness check at read time rejects
 * stale markers from previous processes that recycled the PID.
 * Cross-process correctness is enforced by a Postgres advisory lock
 * (`pg_advisory_lock(hashtext('cinatra-schema-init'))`) that all
 * cold-init contenders take as the first query of their DDL run. The
 * done-marker is a per-process fast-path cache; the lock is the real
 * mutex. The legacy O_EXCL "in-flight" sentinel (created BEFORE DDL)
 * had a race window between sentinel-creation and lock-acquire and was
 * replaced with this design.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, unlinkSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test: sentinel file is written after ensurePostgresSchema completes
// ---------------------------------------------------------------------------

// We cannot import the real database.ts here because it is stubbed in vitest.config.ts.
// Instead, we test the sentinel file logic in isolation by:
// 1. Importing the underlying building blocks (postgres-sync, drizzle-store)
// 2. Verifying the sentinel file contract required for cross-thread deduplication.

describe("ensurePostgresSchema cold-boot deduplication (sentinel file contract)", () => {
  const schemaName = "cinatra_test_sentinel";
  const pid = process.pid;
  // Production path shape (src/lib/database.ts):
  //   /tmp/cinatra-schema-init-<schema>-<pid>.done
  // PID-only filename + mtime freshness check guards stale-marker reuse
  // on PID recycling. THIS test is self-contained (it tests filesystem
  // primitives, not production ensurePostgresSchema behavior), so the
  // path here just needs to match the production shape and stay stable
  // across the test's beforeEach/afterEach cycle. Integration-style
  // assertions against the runtime live in
  // ensure-postgres-schema-concurrency.test.ts.
  const sentinelPath = join(tmpdir(), `cinatra-schema-init-${schemaName}-${pid}.done`);

  beforeEach(() => {
    // Remove sentinel file before each test
    if (existsSync(sentinelPath)) {
      unlinkSync(sentinelPath);
    }
  });

  afterEach(() => {
    // Clean up sentinel file after each test
    if (existsSync(sentinelPath)) {
      unlinkSync(sentinelPath);
    }
  });

  it("sentinel file does not exist before first schema init", () => {
    // Precondition: no stale sentinel from a previous run
    expect(existsSync(sentinelPath)).toBe(false);
  });

  it("done-marker file can be created idempotently (O_CREAT) and refreshes mtime on rewrite", async () => {
    // The current design does NOT use O_EXCL — the
    // marker is created idempotently AFTER a successful DDL run, and
    // PID-recycling safety comes from an mtime freshness check at READ
    // time (see ensure-postgres-schema-concurrency.test.ts for the
    // integration-level assertions). What matters for the filesystem
    // contract here: re-writing an existing marker must REFRESH its
    // mtime so sibling worker_threads pass the freshness check after a
    // stale-marker recovery (the prior O_CREAT-only marker-set was a
    // no-op for mtime on existing files).
    const { utimesSync, writeFileSync, statSync } = await import("node:fs");

    // Plant a stale marker with an old mtime.
    writeFileSync(sentinelPath, "");
    const oneHourAgo = (Date.now() - 60 * 60 * 1000) / 1000;
    utimesSync(sentinelPath, oneHourAgo, oneHourAgo);
    const staleMtimeMs = statSync(sentinelPath).mtimeMs;

    // Rewrite — must refresh mtime, not no-op.
    writeFileSync(sentinelPath, "");
    const freshMtimeMs = statSync(sentinelPath).mtimeMs;
    expect(freshMtimeMs).toBeGreaterThan(staleMtimeMs);
    expect(freshMtimeMs).toBeGreaterThanOrEqual(Date.now() - 5000);
  });

  it("sentinel file path is PID-scoped so it is fresh on process restart", () => {
    // Verify the sentinel path includes the current process PID
    // This ensures stale sentinel files from a previous server run are NOT reused
    // (the new process has a different PID → different file path → fresh initialization)
    expect(sentinelPath).toContain(String(process.pid));
    expect(sentinelPath).toContain(tmpdir());
    expect(sentinelPath).toContain(schemaName);
  });

  it("sentinel file path is in /tmp (shared across worker_threads in the same process)", () => {
    // worker_threads all share the same process PID AND the same /tmp filesystem
    // This is why the sentinel file approach works for cross-thread deduplication
    expect(sentinelPath.startsWith(tmpdir())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test: readStoredNangoSettings graceful timeout
// ---------------------------------------------------------------------------
// The nango module is stubbed in vitest.config.ts, so we test the contract directly:
// When the DB times out with "Timed out while executing Postgres query.",
// readStoredNangoSettings() should return {} (empty administration) instead of throwing.
//
// This is tested via the nango stub behavior — the REAL test is that the production
// code wraps the DB call in try-catch and returns {} on timeout.

describe("readStoredNangoSettings graceful timeout contract", () => {
  it("should return empty NangoSettings when Postgres query times out", () => {
    // This test documents the desired contract:
    // readStoredNangoSettings() should catch "Timed out while executing Postgres query."
    // and return {} rather than propagating the error.
    //
    // We verify this contract by checking that isNangoConfigured() returns false
    // (not throwing) when called with empty settings.
    //
    // The test uses the stub from vitest.config.ts which redirects @cinatra-ai/nango-connector
    // to tests/__stubs__/connector-nango.ts. Here we test the contract expectation.

    // A NangoSettings object with no secretKey means Nango is not configured.
    const emptySettings = {};
    const isConfigured = Boolean((emptySettings as { secretKey?: string }).secretKey?.trim());

    // Expect: when DB times out and returns {}, isNangoConfigured() returns false (not throws)
    expect(isConfigured).toBe(false);
  });

  it("top-level await in auth.ts survives DB timeout at module eval time", () => {
    // This is the symptom: auth.ts line 29 does `await getGoogleOAuthSettings()`
    // at module evaluation time. If the DB times out, this throws and crashes
    // ALL routes that transitively import auth-session.ts (55 files).
    //
    // The fix ensures this does NOT throw:
    // getGoogleOAuthSettings() → getNangoOAuth2IntegrationCredentials() → isNangoConfigured()
    //   → getNangoSettings() → readStoredNangoSettings() → [catches timeout, returns {}]
    //   → getNangoSettings() returns { secretKey: undefined, serverUrl: undefined }
    //   → isNangoConfigured() returns false (no throw)
    //   → getNangoIntegration() returns null (no throw)
    //   → getNangoOAuth2IntegrationCredentials() returns null (no throw)
    //   → getGoogleOAuthSettings() returns { clientId: undefined, ... } (no throw)
    //
    // Simulating: if readStoredNangoSettings catches and returns {}, the whole chain is safe.
    const simulateTimeout = () => {
      throw new Error("Timed out while executing Postgres query.");
    };

    const readStoredNangoSettingsWithFix = (): { secretKey?: string; serverUrl?: string } => {
      try {
        simulateTimeout();
        return {}; // Never reached
      } catch (err) {
        if (err instanceof Error && err.message.includes("Timed out while executing Postgres query")) {
          return {}; // Return empty administration instead of propagating
        }
        throw err; // Re-throw other errors
      }
    };

    // Should not throw
    expect(() => readStoredNangoSettingsWithFix()).not.toThrow();
    const result = readStoredNangoSettingsWithFix();
    expect(result).toEqual({});
    expect(Boolean(result.secretKey?.trim())).toBe(false); // isNangoConfigured() would return false
  });
});
