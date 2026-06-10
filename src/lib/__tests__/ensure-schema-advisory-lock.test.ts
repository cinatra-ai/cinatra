import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Cross-process schema-init DDL serialization + completion-marker guard.
//
// `ensurePostgresSchema()` in src/lib/postgres-schema-init.ts (extracted from
// database.ts in cinatra#104) runs ~180 DDL queries on
// cold boot. Two Turbopack compile workers (separate PIDs) initing the
// schema simultaneously will both run the DDL set and race on `pg_class`
// /`pg_namespace`, surfacing as a 500 with `ERROR: tuple concurrently
// updated`.
//
// The fix prepends `SELECT pg_advisory_lock(hashtext($1))` as the FIRST
// statement of the DDL run, with the fixed database-global text key
// `'cinatra-schema-init'`. The lock is SESSION-scoped (not transaction-
// scoped) — per-query auto-commit semantics are preserved so any thread
// that reads catalog state mid-run sees writes as they land. The
// session-scoped lock auto-releases when the sync worker closes its
// pg.Client (postgres-sync's `finally` block).
//
// The sync-query timeout is bumped above the 30s default so a second
// contender that blocks waiting for the lock + then replays idempotent
// IF-NOT-EXISTS DDL doesn't trip "Timed out while executing Postgres query."
//
// Crucially: there is NO "first wins, others skip" branch. EVERY cold-init
// thread/process runs the DDL under the lock (idempotent IF-NOT-EXISTS is
// fast when the schema already exists), and the per-process done-marker
// file is written ONLY AFTER `runPostgresQueriesSync` returns successfully
// — so by the time any sibling sees the marker, the DDL is provably done.
// The prior O_EXCL "in-flight" sentinel and the waitForSchemaInitDone()
// helper that tried to close the race after-the-fact are both gone.
//
// This test fails if the call site regresses on any of those invariants.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DATABASE_TS = resolve(REPO_ROOT, "src/lib/postgres-schema-init.ts");

function extractEnsureSchemaDdlCall(src: string): string {
  // Find the runPostgresQueriesSync call in ensurePostgresSchema's slow
  // path (the only DDL run in this file). The slow-path comment block
  // opens with "Slow path: serialize across worker PROCESSES" — anchor
  // there.
  const marker = "Slow path: serialize across worker PROCESSES";
  const start = src.indexOf(marker);
  if (start < 0) {
    throw new Error(
      `Could not locate "${marker}" comment in src/lib/postgres-schema-init.ts — has the slow-path comment block been renamed or removed?`,
    );
  }
  // 4500 chars after the marker covers the entire commented block + the
  // runPostgresQueriesSync call + the setSchemaInitDoneMarker call.
  return src.slice(start, start + 4500);
}

describe("ensurePostgresSchema cross-process advisory-lock serialization", () => {
  const src = readFileSync(DATABASE_TS, "utf8");
  const block = extractEnsureSchemaDdlCall(src);

  it("uses session-scoped pg_advisory_lock (NOT xact-scoped) so per-DDL auto-commit semantics are preserved", () => {
    expect(
      /pg_advisory_lock\s*\(\s*hashtext\s*\(\s*\$1\s*\)\s*\)/.test(block),
      "Expected `SELECT pg_advisory_lock(hashtext($1))` (session-scoped) in the DDL run.",
    ).toBe(true);
    expect(
      /pg_advisory_xact_lock/.test(block),
      "DDL run must NOT use `pg_advisory_xact_lock` — a xact-scoped lock requires `transaction: true`, which would defer EVERY DDL commit to the end of the batch and break sibling worker_threads that skip DDL via the file sentinel (they would race on tables/columns not yet visible at any other connection).",
    ).toBe(false);
    expect(
      /transaction:\s*true/.test(block),
      "DDL run must NOT wrap in `transaction: true` — see comment above; per-query auto-commit is required for sibling-thread visibility.",
    ).toBe(false);
  });

  it("uses the database-global text key 'cinatra-schema-init' so per-worktree schemas serialize on shared public.* DDL", () => {
    expect(
      /["']cinatra-schema-init["']/.test(block),
      "Expected the advisory-lock key to be the fixed text `'cinatra-schema-init'`. A per-schema key would race two cold worktrees on shared `public.user`/`public.team`/`public.organization` DDL.",
    ).toBe(true);
  });

  it("places pg_advisory_lock as the FIRST query in the queries array", () => {
    // Extract the first object literal inside `queries: [ ... ]`. The lock
    // SQL appearing somewhere in the block isn't enough — it MUST be the
    // first entry so the rest of the DDL runs under the lock.
    const queriesArrayMatch = block.match(/queries:\s*\[\s*\{([\s\S]*?)\}/);
    expect(
      queriesArrayMatch,
      "Could not parse `queries: [ { ... }` — the DDL call shape has changed; review the test extraction.",
    ).not.toBeNull();
    if (!queriesArrayMatch) return;
    const firstEntry = queriesArrayMatch[1];
    expect(
      /pg_advisory_lock/.test(firstEntry),
      "The FIRST entry in the `queries` array must be the advisory lock — putting it anywhere else leaves the leading DDL queries unprotected.",
    ).toBe(true);
  });

  it("elevates the sync-query timeout above the 30s default", () => {
    const match = block.match(/timeoutMs:\s*([\d_]+)/);
    expect(
      match,
      "DDL run must pass an explicit `timeoutMs` above the 30s default so a second-acquirer can wait on the lock + replay idempotent DDL without timing out.",
    ).not.toBeNull();
    if (!match) return;
    const ms = Number(match[1].replaceAll("_", ""));
    expect(ms).toBeGreaterThanOrEqual(60_000);
  });

  it("writes the done-marker ONLY after the DDL run returns successfully", () => {
    // The marker write must come AFTER runPostgresQueriesSync — otherwise a
    // sibling that hits the marker fast path can race against an
    // in-progress DDL run. setSchemaInitDoneMarker should also NOT be
    // inside a try/catch swallowing the DDL failure: a failed init must
    // NOT mark the schema done.
    const ddlIdx = block.search(/runPostgresQueriesSync\s*\(/);
    const markerIdx = block.search(/setSchemaInitDoneMarker\s*\(/);
    expect(ddlIdx, "Expected `runPostgresQueriesSync(` in the slow-path block.").toBeGreaterThan(-1);
    expect(markerIdx, "Expected `setSchemaInitDoneMarker(` in the slow-path block.").toBeGreaterThan(-1);
    expect(
      markerIdx > ddlIdx,
      "`setSchemaInitDoneMarker(...)` must appear AFTER `runPostgresQueriesSync(...)` so the marker reflects a successfully-committed DDL run. If the call moves before the DDL run, sibling threads can hit the marker fast path while the DDL is still in flight.",
    ).toBe(true);
  });

  it("has no 'first wins, others skip' branch — the prior in-flight sentinel is gone", () => {
    // The previous design ("isSchemaInitSentinelSet → skip" / "tryAcquire
    // failed → skip + wait") had a race where a loser could proceed past
    // the wait before the winner had actually started DDL. The fix removes
    // both branches and lets every cold-init thread run idempotent DDL
    // under the database-global advisory lock. Detect any regression that
    // re-introduces the in-flight sentinel helpers in ensurePostgresSchema.
    const fullFn = src.slice(
      src.indexOf("export function ensurePostgresSchema()"),
      src.indexOf("function readMetadataValueInternal"),
    );
    expect(
      /\bisSchemaInitSentinelSet\b/.test(fullFn),
      "`isSchemaInitSentinelSet` must not be called from ensurePostgresSchema — it represents the dropped in-flight sentinel race.",
    ).toBe(false);
    expect(
      /\btryAcquireSchemaInitSentinel\b/.test(fullFn),
      "`tryAcquireSchemaInitSentinel` must not be called from ensurePostgresSchema — it represents the dropped in-flight sentinel race.",
    ).toBe(false);
    expect(
      /\bwaitForSchemaInitDone\b/.test(fullFn),
      "`waitForSchemaInitDone` must not be called from ensurePostgresSchema — it was the after-the-fact fix for the in-flight sentinel race, no longer needed once the sentinel was dropped.",
    ).toBe(false);
  });
});
