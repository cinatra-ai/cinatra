// Core-store schema migration runner — node-pg-migrate, driven programmatically.
//
// THE canonical implementation for cinatra#116 (umbrella #115: one migration
// engine org-wide). Three consumers share it so the options can never drift:
//   - `cinatra setup dev|prod` / `setup branch` (packages/cli/src/index.mjs),
//   - the app boot pass (src/lib/core-migrations.ts -> src/instrumentation.node.ts),
//   - the ops entry point (`cinatra db migrate [--down] [--count=N]`).
//
// Design contract (see migrations/README.md for the authoring convention):
//   - Migrations are code modules at migrations/core/core__NNNN_<desc>.mjs.
//     The `core__` prefix is the per-source ledger namespace from #115 —
//     extension migrations (#118) will share the SAME ledger under
//     `ext_<scope>_<pkg>__NNNN…` names, so sources can never collide.
//   - ONE ledger: `pgmigrations` in the app schema (SUPABASE_SCHEMA). Each
//     worktree/branch schema carries its own ledger, mirroring the per-schema
//     bootstrap DDL.
//   - Serialization: the SAME database-global advisory lock the bootstrap DDL
//     (`ensurePostgresSchema`, session-scoped) and the extension migration
//     host (xact-scoped) already contend on — `hashtext('cinatra-schema-init')`.
//     node-pg-migrate's own lock is disabled (`noLock`): it is a TRY-lock that
//     would fail-fast under contention instead of queueing, and it uses an
//     unrelated key.
//   - A DEDICATED short-lived pg.Client (created INSIDE the call — never a
//     top-level pool, preserving the `next build` page-data invariant). The
//     runner issues a session-level `SET search_path` and we hold a
//     session-scoped advisory lock; ending the session releases both, which a
//     pooled client would leak back into the pool.
//   - `checkOrder: false`: node-pg-migrate's positional order check assumes
//     the ledger contains ONLY this dir's migrations — false by design once
//     #118 lands extension rows in the shared ledger. Its safety is replaced
//     by (a) the filename/seq preflight below (runtime) and (b) the
//     schema-migration CI gate's append-only + strictly-increasing-seq rules.
//
// Plain ESM on purpose: imported by the CLI (plain node, also inside the
// standalone prod image), by src/lib (Next bundles it), and by vitest.
// Heavy deps (`pg`, `node-pg-migrate`) load lazily inside the run call.

import path from "node:path";
import { readdir } from "node:fs/promises";

/** Directory (relative to the repo/app root) holding core migration modules. */
export const CORE_MIGRATIONS_DIR = "migrations/core";

/** The shared migrations ledger table (lives in the app schema). */
export const CORE_MIGRATIONS_TABLE = "pgmigrations";

/** Per-source ledger namespace for core migrations (#115). */
export const CORE_MIGRATION_NAMESPACE = "core__";

/**
 * Filename contract for core migration modules:
 * core__NNNN_short-description.mjs (NNNN zero-padded, strictly increasing,
 * append-only — enforced by scripts/audit/schema-migration-gate.mjs).
 */
export const CORE_MIGRATION_FILE_RE = /^core__(\d{4})_([a-z0-9][a-z0-9-]*)\.mjs$/;

/** Advisory-lock key shared with ensurePostgresSchema + the extension host. */
export const CORE_MIGRATION_LOCK_KEY = "cinatra-schema-init";

/**
 * Bound the advisory-lock wait (ms). Mirrors the bootstrap DDL's 120s budget
 * (src/lib/postgres-schema-init.ts): a contender behind a cold-init bootstrap
 * may legitimately queue for tens of seconds.
 */
export const CORE_MIGRATION_LOCK_TIMEOUT_MS = 120_000;

/**
 * Preflight for migrations/core/: every visible file must match the filename
 * contract and seqs must be unique. This is the runtime replacement for the
 * ordering safety `checkOrder: false` gives up (see header).
 *
 * @param {string} dirAbs absolute path of the migrations/core directory
 * @returns {Promise<string[]>} the matched filenames, sorted
 */
export async function validateCoreMigrationsDir(dirAbs) {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      `[core-migrations] cannot read ${dirAbs} — the migrations/core directory must ship with the app (Dockerfile copies migrations/ into the runtime image)`,
      { cause },
    );
  }
  const files = entries
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
  const seqs = new Set();
  for (const name of files) {
    const m = name.match(CORE_MIGRATION_FILE_RE);
    if (!m) {
      throw new Error(
        `[core-migrations] ${name} does not match the core migration filename contract core__NNNN_short-description.mjs (see migrations/README.md)`,
      );
    }
    if (seqs.has(m[1])) {
      throw new Error(`[core-migrations] duplicate core migration sequence number ${m[1]} (${name})`);
    }
    seqs.add(m[1]);
  }
  return files;
}

/**
 * Down-direction fence for the SHARED ledger: node-pg-migrate `down` pops the
 * last N ledger rows regardless of which source wrote them. Refuse to run
 * unless every targeted row is a core migration. (#118 inherits this problem
 * for per-extension rollback and must filter by its own namespace.)
 *
 * @param {string[]} lastRunNames newest-first ledger names limited to `count`
 */
export function assertDownTargetsAreCore(lastRunNames) {
  const foreign = lastRunNames.filter((n) => !n.startsWith(CORE_MIGRATION_NAMESPACE));
  if (foreign.length > 0) {
    throw new Error(
      `[core-migrations] refusing to migrate down: the most recent ledger entr${foreign.length === 1 ? "y is" : "ies are"} not core migrations (${foreign.join(", ")}). ` +
        `node-pg-migrate reverts the newest ledger rows regardless of source; revert the owning source first or lower --count.`,
    );
  }
}

/**
 * Quote an identifier for direct interpolation (ledger probe / fence query).
 * @param {string} id
 */
function quoteIdent(id) {
  return `"${String(id).replaceAll('"', '""')}"`;
}

/**
 * Build the node-pg-migrate logger: forwards everything except the benign
 * "Can't determine timestamp" notice that our deliberately non-timestamp
 * `core__NNNN` prefixes trigger on every load.
 * @param {(msg: string) => void} log
 */
function buildRunnerLogger(log) {
  const forward = (level) => (msg, ...rest) => {
    if (typeof msg === "string" && msg.startsWith("Can't determine timestamp for ")) return;
    log(`[core-migrations] ${level === "info" ? "" : `${level}: `}${msg}${rest.length ? ` ${rest.join(" ")}` : ""}`);
  };
  return { debug: undefined, info: forward("info"), warn: forward("warn"), error: forward("error") };
}

/**
 * Run the core migration chain.
 *
 * @param {object} input
 * @param {string} input.connectionString  Postgres connection string.
 * @param {string} input.schemaName        App schema (SUPABASE_SCHEMA; ledger + search_path).
 * @param {string} input.rootDir           Repo/app root containing migrations/core.
 * @param {"up"|"down"} [input.direction]
 * @param {number} [input.count]           down: how many to revert (default 1); up: cap (default all).
 * @param {boolean} [input.fake]           Record the chain in the ledger WITHOUT executing it.
 *                                         Used by setup on a FRESH schema, where the idempotent
 *                                         bootstrap DDL already produces the post-migration shape;
 *                                         executing historical ALTERs against base tables that the
 *                                         full bootstrap has not built yet would fail.
 * @param {(msg: string) => void} [input.log]
 * @returns {Promise<{ ranNames: string[], direction: "up"|"down", faked: boolean }>}
 *
 * Errors thrown before a usable session exists carry `phase: "connect"` so
 * the boot policy (src/lib/core-migrations.ts) can stay tolerant of an
 * unreachable/unprovisioned database while treating real migration failures
 * as fatal in production.
 */
export async function runCoreMigrations({
  connectionString,
  schemaName,
  rootDir,
  direction = "up",
  count,
  fake = false,
  log = console.log,
}) {
  if (!connectionString) throw new Error("[core-migrations] connectionString is required");
  if (!schemaName) throw new Error("[core-migrations] schemaName is required");
  if (direction !== "up" && direction !== "down") {
    throw new Error(`[core-migrations] unsupported direction "${direction}"`);
  }

  const dir = path.resolve(rootDir, CORE_MIGRATIONS_DIR);
  await validateCoreMigrationsDir(dir);

  const { default: pg } = await import("pg");
  const { runner } = await import("node-pg-migrate");

  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
  } catch (error) {
    // Tag connection-phase failures: the database being unreachable is a
    // different beast from a migration failing (boot policy distinguishes).
    error.phase = "connect";
    throw error;
  }

  try {
    // Serialize against bootstrap DDL + extension migrations on the shared
    // database-global key. Session-scoped: dies with this dedicated session.
    // Bounded wait so a wedged lock holder surfaces as a clear timeout
    // instead of an indefinite hang (parity with the bootstrap's budget).
    await client.query(`SET statement_timeout = ${CORE_MIGRATION_LOCK_TIMEOUT_MS}`);
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [CORE_MIGRATION_LOCK_KEY]);
    // Migrations own their runtime; do not cap long backfills.
    await client.query("RESET statement_timeout");

    if (direction === "down") {
      const fenceCount = Math.abs(count ?? 1);
      const ledger = `${quoteIdent(schemaName)}.${quoteIdent(CORE_MIGRATIONS_TABLE)}`;
      const exists = await client.query("SELECT to_regclass($1) AS t", [ledger]);
      if (!exists.rows[0]?.t) {
        log("[core-migrations] no ledger table — nothing to revert");
        return { ranNames: [], direction, faked: false };
      }
      const last = await client.query(
        `SELECT name FROM ${ledger} ORDER BY run_on DESC, id DESC LIMIT $1`,
        [fenceCount],
      );
      assertDownTargetsAreCore(last.rows.map((r) => r.name));
    }

    const ran = await runner({
      dbClient: client,
      dir,
      migrationsTable: CORE_MIGRATIONS_TABLE,
      schema: schemaName,
      // The schema normally pre-exists (bootstrap/setup creates it); cheap
      // belt-and-braces for direct ops invocations on a fresh database.
      createSchema: true,
      // We hold the cinatra-schema-init advisory lock above; node-pg-migrate's
      // own TRY-lock must not stack a second, unrelated one.
      noLock: true,
      // Shared-ledger design (#115): see module header.
      checkOrder: false,
      direction,
      ...(count !== undefined || direction === "down" ? { count: Math.abs(count ?? 1) } : {}),
      fake,
      verbose: false,
      logger: buildRunnerLogger(log),
    });
    return { ranNames: ran.map((m) => m.name), direction, faked: fake };
  } finally {
    // Ends the dedicated session: releases the advisory lock and discards the
    // runner's session-level search_path. Nothing leaks.
    try {
      await client.end();
    } catch {
      /* the session dies with the process either way */
    }
  }
}

/**
 * Freshness probe used by setup flows: a schema with no `metadata` store
 * table has never been set up or booted — its bootstrap DDL will produce the
 * CURRENT shape, so the historical chain must be ledger-faked, not executed.
 *
 * @param {{ query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }} client
 * @param {string} schemaName
 * @returns {Promise<boolean>}
 */
export async function isFreshCoreSchema(client, schemaName) {
  const result = await client.query("SELECT to_regclass($1) AS t", [
    `${quoteIdent(schemaName)}.metadata`,
  ]);
  return !result.rows[0]?.t;
}
