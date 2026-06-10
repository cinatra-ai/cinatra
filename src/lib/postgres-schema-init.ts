// Postgres schema initialization (`ensurePostgresSchema`) — SYNC module.
//
// Extracted from src/lib/database.ts (cinatra#104) so that synchronous leaf
// stores (artifact-refs-store and friends) can STATICALLY import
// `ensurePostgresSchema` without touching database.ts. database.ts is an
// async module under Turbopack dev (its graph reaches `import()`-loaded
// externals via objects-store -> @/lib/mcp-server), and a CommonJS
// `require()` of an async module returns the module's Promise — every named
// export reads as `undefined`. See src/lib/postgres-config.ts for the full
// mechanism write-up.
//
// ## Sync contract
//
// Imports here must stay synchronous under Turbopack: Node builtins,
// postgres-sync (worker_threads bridge), drizzle-store (SQL-text builders —
// driverless by design, see its pg-proxy note), and the postgres-config
// leaf. Enforced by src/lib/__tests__/postgres-sync-leaf-imports.test.ts.
//
// database.ts re-exports `ensurePostgresSchema` so existing importers keep
// working unchanged.
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";

declare global {
  // Survives Turbopack HMR module re-evaluation — prevents re-running 30+
  // schema queries on every new route compilation in dev mode.
  var __cinatraPostgresSchemaInitialized: boolean | undefined;
}

// Stored on globalThis so Turbopack HMR module re-evaluation (per new route
// compilation) does not reset the flag and re-run 30+ schema queries.
// A module-level `let` would reset to false on every new route load in dev mode,
// causing a 2–5 s Atomics.wait block on the first DB call after each HMR cycle.
function isPostgresSchemaInitialized() {
  return globalThis.__cinatraPostgresSchemaInitialized === true;
}
function markPostgresSchemaInitialized() {
  globalThis.__cinatraPostgresSchemaInitialized = true;
}

// Done-marker file for ensurePostgresSchema (per-process fast-path cache).
//
// `/tmp/cinatra-schema-init-<schema>-<pid>.done` is written ONLY after the
// DDL run successfully commits. Subsequent cold-init callers within the
// same process (sibling worker_threads, new request handlers, etc.) see
// the marker and short-circuit without opening a Postgres session.
//
// PID-scoped + mtime freshness check: cross-process correctness is enforced
// by the Postgres advisory lock inside the slow-path DDL run; this file
// marker is purely an optimization to avoid the DB round-trip on warm
// callers within a single process. The mtime check is critical because
// `/tmp` files survive process crashes and PIDs are recycled by the OS:
// without freshness, a later server process receiving the same PID would
// read a stale marker and silently skip DDL on a fresh database.
//
// Cross-thread shareability requires the marker filename to be derivable
// from process-wide values only. `process.pid` and the filesystem path are
// process-wide (all worker_threads see the same). A nonce computed from
// `Math.random()` would be PER-ISOLATE (each Turbopack worker_thread runs
// in its own V8 isolate with its own RNG seed), so sibling threads would
// each compute different paths and the fast-path optimization would only
// apply within a single thread. Likewise `performance.timeOrigin` is
// per-worker, not per-process. The mtime check is the cleanest
// process-wide freshness primitive available without crossing into
// platform-specific procfs/sysctl reads.
//
// Differs from the prior O_EXCL "in-flight" sentinel: that one was created
// BEFORE DDL ran (winner mid-DDL → marker exists → loser sees marker →
// loser races against winner's not-yet-committed catalog). The done-marker
// is created AFTER `runPostgresQueriesSync` returns successfully, so by the
// time another thread sees it, the DDL is provably committed.
//
// Filename suffix `.done` matches the legacy sentinel for operator grep
// continuity, but the SEMANTICS now match the suffix: the file exists iff
// init is provably DONE.
//
// Approximate process-start epoch in ms — computed at module load and
// frozen. `process.uptime()` is process-wide (not per-isolate) in Node.js
// per https://nodejs.org/api/process.html#processuptime, so worker_threads
// in the same OS process all compute the same value here. ~2s of slack
// is added when reading the marker mtime to absorb (a) the float-ms drift
// inherent in `Date.now() - process.uptime() * 1000` across isolates and
// (b) any clock skew between this process and the filesystem's mtime
// clock — both negligible in practice but worth budgeting for.
const PROCESS_START_EPOCH_MS: number = Math.floor(Date.now() - process.uptime() * 1000);
const STALE_MARKER_TOLERANCE_MS = 2000;

function getSchemaInitDoneMarkerPath(schema: string): string {
  return path.join(tmpdir(), `cinatra-schema-init-${schema}-${process.pid}.done`);
}

function isSchemaInitDoneMarkerSet(schema: string): boolean {
  // Single statSync handles both "missing" and "stale" cases. Fail-soft:
  // any stat error (ENOENT, perms, race-unlink between caller threads)
  // treats the marker as absent so cold init re-runs under the lock.
  try {
    const stat = statSync(getSchemaInitDoneMarkerPath(schema));
    if (!stat.isFile()) return false;
    // Reject markers whose mtime predates this process's start: they
    // belong to a previous process that crashed before cleaning up
    // (PID recycling). 2s tolerance absorbs (a) the few-ms drift in
    // Date.now() - process.uptime() * 1000 across module loads and
    // (b) clock skew between this process and the filesystem mtime
    // clock — both negligible on modern systems but worth budgeting.
    return stat.mtimeMs >= PROCESS_START_EPOCH_MS - STALE_MARKER_TOLERANCE_MS;
  } catch {
    return false;
  }
}

function setSchemaInitDoneMarker(schema: string): void {
  // `writeFileSync(path, "")` creates the file if absent AND truncates +
  // writes if it already exists — both code paths update the file's mtime.
  // This is critical for PID-reuse recovery: when this process inherits a
  // stale marker (rejected by the freshness check), we must REFRESH the
  // mtime so subsequent sibling worker_threads in this process pass the
  // freshness check on their fast-path read. A bare `openSync(O_CREAT)`
  // on an existing file is a no-op for mtime and would leave us looping.
  //
  // Fail-soft on /tmp unavailability — the globalThis flag still
  // short-circuits subsequent calls on this thread.
  try {
    writeFileSync(getSchemaInitDoneMarkerPath(schema), "");
  } catch {
    /* non-fatal */
  }
}

export function ensurePostgresSchema() {
  // Gated inline perf probe (no import; keep this low-level module
  // dependency-free), zero behavior change. Proves ensurePostgresSchema is
  // one-time per process: `acquired-ddl` exactly once, then
  // `global-hit`/`sentinel-hit` on every later request.
  const __perf = process.env.CINATRA_PERF_NOTIFICATIONS === "1";

  // Per-thread globalThis guard (HMR dedup within the same worker_thread).
  if (isPostgresSchemaInitialized()) {
    if (__perf) console.log(`[notif-perf] pid=${process.pid} ensurePostgresSchema=global-hit`);
    return;
  }

  // Per-process done-marker fast path. The marker is written ONLY after the
  // slow-path DDL run successfully commits (see setSchemaInitDoneMarker
  // call below), so its existence is a TRUE completion signal — any thread
  // that sees it can proceed to real reads without further serialization.
  if (isSchemaInitDoneMarkerSet(postgresSchema)) {
    markPostgresSchemaInitialized();
    if (__perf) console.log(`[notif-perf] pid=${process.pid} ensurePostgresSchema=marker-hit`);
    return;
  }

  // Slow path: serialize across worker PROCESSES via a Postgres advisory
  // lock and run the (idempotent) DDL set. EVERY cold-init thread/process
  // takes this path — first acquirer does the real ~30s DDL work,
  // subsequent acquirers run fast IF-NOT-EXISTS no-ops (~5s) under the
  // lock. No winner/loser distinction: by the time `runPostgresQueriesSync`
  // returns, this thread has provably committed (or re-validated) every
  // table/column/index/trigger the rest of the codebase will read.
  //
  // ## Why this design (not "first wins, others skip")
  //
  // A prior in-flight sentinel ("file exists ⇒ another thread will finish
  // shortly, skip") had a real race: a sibling could see the sentinel and
  // proceed to real reads while the winner was still mid-DDL — surfacing
  // as `relation does not exist` / missing-column errors. With a true
  // post-DDL done-marker plus an advisory lock that serializes the slow
  // path, the only way to mark initialized in this branch is to FIRST
  // synchronously run the DDL ourselves; siblings cannot race past us.
  //
  // ## Lock shape: SESSION-scoped (not xact-scoped) — auto-release on
  // ## worker session end
  //
  // `pg_advisory_lock(hashtext('cinatra-schema-init'))` mirrors the
  // existing in-tree text-hash pattern (artifact-refs, semantic-assertion,
  // mutation service, workflows engine, anthropic-skill-sync) but is
  // SESSION-scoped, not transaction-scoped. WHY: a transaction-scoped
  // wrapper would defer EVERY DDL commit to the end of the batch — sibling
  // worker_threads that hit the done-marker fast path during/after this
  // run rely on per-query auto-commit to see catalog state at any time.
  //
  // No explicit `pg_advisory_unlock` query is needed: postgres-sync's
  // worker always closes the pg.Client in its `finally` block (see
  // postgres-sync.ts:74 — `try { await client.end(); } catch {}`),
  // ending the Postgres session, and Postgres releases all
  // session-scoped advisory locks on session end. This is leak-safe even
  // if a DDL query throws midway (catch block surfaces the error, finally
  // still closes the session).
  //
  // ## Why DATABASE-GLOBAL, not per-schema
  //
  // `buildCreateStoreSchemaQueries(postgresSchema)` is NOT purely
  // per-schema — it ALSO ALTERs / CREATEs TRIGGERs / INDEXes on shared
  // `public.*` Better Auth tables (`public."user"`, `public."team"`,
  // `public."organization"`; see e.g. drizzle-store.ts lines 2789, 2916,
  // 2923, 3108, 3140, 3167). Two different worktree schemas
  // (`cinatra_<slugA>`, `cinatra_<slugB>`) cold-initing simultaneously
  // would race on those public-catalog objects, so the lock MUST be
  // database-global to be correct (single `'cinatra-schema-init'` text
  // key for every schema in the DB).
  //
  // ## Timeout
  //
  // Default sync-query timeout in postgres-sync.ts is 30s. A second
  // contender blocks ~30s on the lock, then runs idempotent IF-NOT-EXISTS
  // DDL (~5s when tables already exist). Bumped to 120s so neither the
  // wait nor the replay trips "Timed out while executing Postgres query."
  const __t0 = process.hrtime.bigint();
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    timeoutMs: 120_000,
    queries: [
      {
        text: "SELECT pg_advisory_lock(hashtext($1))",
        values: ["cinatra-schema-init"],
      },
      ...buildCreateStoreSchemaQueries(postgresSchema),
    ],
  });

  // DDL run returned successfully (no try/catch needed — a thrown error
  // here legitimately means schema init failed and we should propagate;
  // the missing done-marker means next cold-init call will retry the run).
  setSchemaInitDoneMarker(postgresSchema);
  markPostgresSchemaInitialized();
  if (__perf)
    console.log(
      `[notif-perf] pid=${process.pid} ensurePostgresSchema=acquired-ddl ddlMs=${(Number(process.hrtime.bigint() - __t0) / 1e6).toFixed(0)}`,
    );
}
