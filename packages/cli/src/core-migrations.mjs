// Schema migration runner — node-pg-migrate, driven programmatically.
//
// THE canonical implementation for cinatra#116 + #118 (umbrella #115: one
// migration engine org-wide). Consumers share it so the options can never drift:
//   - `cinatra setup dev|prod` / `setup branch` (packages/cli/src/index.mjs),
//   - the app boot pass (src/lib/core-migrations.ts -> src/instrumentation.node.ts),
//   - the ops entry point (`cinatra db migrate [--down] [--count=N]`),
//   - the extension migration host (src/lib/extension-migration-host.ts), which
//     runs a trusted-signed extension's migration chain through
//     `runNamespacedMigrations` (#118).
//
// Design contract (see migrations/README.md for the authoring convention):
//   - Migrations are code modules named `<namespace>NNNN_<desc>.mjs`. The
//     namespace is the per-source ledger partition from #115 — `core__` for
//     migrations/core/, `ext_<scope>_<pkg>__` for an extension's declared
//     migrations dir (#118) — so independently-versioned sources can never
//     collide in the shared ledger.
//   - ONE ledger: `pgmigrations` in the app schema (SUPABASE_SCHEMA). Each
//     worktree/branch schema carries its own ledger, mirroring the per-schema
//     bootstrap DDL.
//   - Serialization: the SAME database-global advisory lock the bootstrap DDL
//     (`ensurePostgresSchema`, session-scoped) contends on —
//     `hashtext('cinatra-schema-init')`. node-pg-migrate's own lock is disabled
//     (`noLock`): it is a TRY-lock that would fail-fast under contention
//     instead of queueing, and it uses an unrelated key.
//   - A DEDICATED short-lived pg.Client (created INSIDE the call — never a
//     top-level pool, preserving the `next build` page-data invariant). The
//     runner issues a session-level `SET search_path` and we hold a
//     session-scoped advisory lock; ending the session releases both, which a
//     pooled client would leak back into the pool.
//   - `checkOrder: false`: node-pg-migrate's positional order check assumes
//     the ledger contains ONLY this dir's migrations — false by design in the
//     shared multi-source ledger. Its safety is replaced by (a) the
//     filename/seq preflight below (runtime) and (b) the schema-migration CI
//     gate's append-only + strictly-increasing-seq rules (core), respectively
//     the signed-package immutability of a materialized store dir (extensions).
//   - `down` is fenced PER NAMESPACE: node-pg-migrate pops the newest ledger
//     rows regardless of source, so a run refuses when the newest rows belong
//     to another source.
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

/** Fixed prefix every EXTENSION migration namespace carries (#115/#118). */
export const EXT_MIGRATION_NAMESPACE_PREFIX = "ext_";

/**
 * Hard cap for a ledger name (the migration filename without `.mjs`):
 * node-pg-migrate's `pgmigrations.name` column is varchar(255).
 */
export const MIGRATION_NAME_MAX_LENGTH = 255;

/**
 * Filename contract for core migration modules:
 * core__NNNN_short-description.mjs (NNNN zero-padded, strictly increasing,
 * append-only — enforced by scripts/audit/schema-migration-gate.mjs).
 */
export const CORE_MIGRATION_FILE_RE = /^core__(\d{4})_([a-z0-9][a-z0-9-]*)\.mjs$/;

/** Advisory-lock key shared with ensurePostgresSchema. */
export const CORE_MIGRATION_LOCK_KEY = "cinatra-schema-init";

/**
 * Bound the advisory-lock wait (ms). Mirrors the bootstrap DDL's 120s budget
 * (src/lib/postgres-schema-init.ts): a contender behind a cold-init bootstrap
 * may legitimately queue for tens of seconds.
 */
export const CORE_MIGRATION_LOCK_TIMEOUT_MS = 120_000;

/** Package-name segment contract (npm scope / name, kebab-case). */
const NAME_SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Human label for a namespace in error messages (`core`, `ext_<scope>_<pkg>`). */
function namespaceLabel(namespace) {
  return namespace === CORE_MIGRATION_NAMESPACE ? "core" : namespace.replace(/__$/, "");
}

/**
 * Full ledger-partition shape: `core__` or `ext_<scope>_<pkg>__`.
 * Fencing is `startsWith`-based, so a TRUNCATED namespace (e.g.
 * `ext_cinatra-ai_note`) would silently match a DIFFERENT package's rows —
 * every public entry point must reject a namespace that is not a complete
 * partition key before any preflight or fence runs.
 */
const NAMESPACE_SHAPE_RE = /^(?:core__|ext_[a-z0-9][a-z0-9-]*_[a-z0-9][a-z0-9-]*__)$/;

/**
 * Assert `namespace` is a complete per-source ledger partition key.
 * @param {string} namespace
 */
export function assertValidNamespace(namespace) {
  if (typeof namespace !== "string" || !NAMESPACE_SHAPE_RE.test(namespace)) {
    throw new Error(
      `[migrations] invalid namespace "${namespace}" — expected the full partition key ` +
        `"core__" or "ext_<scope>_<pkg>__" (lowercase kebab-case segments, trailing double underscore included). ` +
        `A partial namespace must never reach prefix-based fencing.`,
    );
  }
}

/**
 * Derive the per-source ledger namespace for an extension package (#115/#118):
 * `@<scope>/<name>` -> `ext_<scope>_<name>__`. Fail closed on anything else:
 * the namespace must be unambiguous under `startsWith` fencing, so both
 * segments are restricted to `[a-z0-9-]` (no `_`, no `.`/`~`) and a scope is
 * REQUIRED (every first-party extension is `@cinatra-ai/...`-scoped).
 *
 * @param {string} packageName
 * @returns {string} the namespace, including the trailing `__`
 */
export function extensionMigrationNamespace(packageName) {
  const m = /^@([^/]+)\/([^/]+)$/.exec(String(packageName ?? ""));
  if (!m || !NAME_SEGMENT_RE.test(m[1]) || !NAME_SEGMENT_RE.test(m[2])) {
    throw new Error(
      `[migrations] cannot derive a migration namespace for package "${packageName}" — ` +
        `extension migrations require a scoped package name (@scope/name) whose scope and name ` +
        `are lowercase kebab-case ([a-z0-9-], no underscores or dots)`,
    );
  }
  return `${EXT_MIGRATION_NAMESPACE_PREFIX}${m[1]}_${m[2]}__`;
}

/**
 * Filename contract for one namespace: `<namespace>NNNN_short-description.mjs`.
 * @param {string} namespace
 */
export function migrationFileReForNamespace(namespace) {
  return new RegExp(`^${escapeRegExp(namespace)}(\\d{4})_([a-z0-9][a-z0-9-]*)\\.mjs$`);
}

/**
 * Preflight a migrations directory for ONE namespace: every visible file must
 * match the filename contract, seqs must be unique, and ledger names must fit
 * the ledger column. This is the runtime replacement for the ordering safety
 * `checkOrder: false` gives up (see header).
 *
 * @param {string} dirAbs absolute path of the migrations directory
 * @param {object} opts
 * @param {string} opts.namespace        per-source namespace incl. trailing `__`
 * @param {boolean} [opts.allowSymlinks] core keeps historical tolerance; extension
 *                                       dirs MUST be real files (a symlink could
 *                                       alias content from outside the verified
 *                                       store dir — node-pg-migrate would follow it)
 * @param {string} [opts.missingDirHint] actionable hint when the dir is unreadable
 * @returns {Promise<string[]>} the matched filenames, sorted
 */
export async function validateNamespacedMigrationsDir(
  dirAbs,
  { namespace, allowSymlinks = false, missingDirHint },
) {
  assertValidNamespace(namespace);
  const label = namespaceLabel(namespace);
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch (cause) {
    throw new Error(
      `[${label}-migrations] cannot read ${dirAbs}${missingDirHint ? ` — ${missingDirHint}` : ""}`,
      { cause },
    );
  }
  const fileRe = migrationFileReForNamespace(namespace);
  const visible = entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const files = [];
  const seqs = new Set();
  for (const e of visible) {
    if (e.isSymbolicLink() && !allowSymlinks) {
      throw new Error(
        `[${label}-migrations] ${e.name} is a symlink — migration modules must be regular files inside the migrations directory`,
      );
    }
    const name = e.name;
    const m = name.match(fileRe);
    if (!m || (!e.isFile() && !e.isSymbolicLink())) {
      throw new Error(
        `[${label}-migrations] ${name} does not match the ${label} migration filename contract ${namespace}NNNN_short-description.mjs (see migrations/README.md)`,
      );
    }
    if (name.length - ".mjs".length > MIGRATION_NAME_MAX_LENGTH) {
      throw new Error(
        `[${label}-migrations] ${name} exceeds the ledger name limit (${MIGRATION_NAME_MAX_LENGTH} chars without extension)`,
      );
    }
    if (seqs.has(m[1])) {
      throw new Error(`[${label}-migrations] duplicate ${label} migration sequence number ${m[1]} (${name})`);
    }
    seqs.add(m[1]);
    files.push(name);
  }
  return files;
}

/**
 * Core-namespace preflight for migrations/core/ (the stable surface the
 * CLI/tests pinned in #116).
 *
 * @param {string} dirAbs absolute path of the migrations/core directory
 * @returns {Promise<string[]>} the matched filenames, sorted
 */
export async function validateCoreMigrationsDir(dirAbs) {
  return validateNamespacedMigrationsDir(dirAbs, {
    namespace: CORE_MIGRATION_NAMESPACE,
    allowSymlinks: true,
    missingDirHint:
      "the migrations/core directory must ship with the app (Dockerfile copies migrations/ into the runtime image)",
  });
}

/**
 * Down-direction fence for the SHARED ledger: node-pg-migrate `down` pops the
 * last N ledger rows regardless of which source wrote them. Refuse to run
 * unless every targeted row belongs to `namespace`.
 *
 * @param {string[]} lastRunNames newest-first ledger names limited to `count`
 * @param {string} namespace
 */
export function assertDownTargetsInNamespace(lastRunNames, namespace) {
  assertValidNamespace(namespace);
  const label = namespaceLabel(namespace);
  const foreign = lastRunNames.filter((n) => !n.startsWith(namespace));
  if (foreign.length > 0) {
    throw new Error(
      `[${label}-migrations] refusing to migrate down: the most recent ledger entr${foreign.length === 1 ? "y is" : "ies are"} not ${label} migrations (${foreign.join(", ")}). ` +
        `node-pg-migrate reverts the newest ledger rows regardless of source; revert the owning source first or lower --count.`,
    );
  }
}

/**
 * Core down fence (stable #116 surface).
 * @param {string[]} lastRunNames newest-first ledger names limited to `count`
 */
export function assertDownTargetsAreCore(lastRunNames) {
  assertDownTargetsInNamespace(lastRunNames, CORE_MIGRATION_NAMESPACE);
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
 * `<namespace>NNNN` prefixes trigger on every load.
 * @param {(msg: string) => void} log
 * @param {string} label
 */
function buildRunnerLogger(log, label) {
  const forward = (level) => (msg, ...rest) => {
    if (typeof msg === "string" && msg.startsWith("Can't determine timestamp for ")) return;
    log(`[${label}-migrations] ${level === "info" ? "" : `${level}: `}${msg}${rest.length ? ` ${rest.join(" ")}` : ""}`);
  };
  return { debug: undefined, info: forward("info"), warn: forward("warn"), error: forward("error") };
}

/**
 * Run ONE source's migration chain against the shared ledger.
 *
 * @param {object} input
 * @param {string} input.connectionString  Postgres connection string.
 * @param {string} input.schemaName        App schema (SUPABASE_SCHEMA; ledger + search_path).
 * @param {string} input.dirAbs            Absolute migrations directory for this source.
 * @param {string} input.namespace         Per-source ledger namespace incl. trailing `__`.
 * @param {"up"|"down"} [input.direction]
 * @param {number} [input.count]           down: how many to revert (default 1); up: cap (default all).
 * @param {boolean} [input.fake]           Record the chain in the ledger WITHOUT executing it.
 * @param {boolean} [input.allowSymlinks]  See {@link validateNamespacedMigrationsDir}.
 * @param {string} [input.missingDirHint]
 * @param {(msg: string) => void} [input.log]
 * @returns {Promise<{ ranNames: string[], direction: "up"|"down", faked: boolean }>}
 *
 * Errors thrown before a usable session exists carry `phase: "connect"` so
 * callers (the boot policy, the extension host) can stay tolerant of an
 * unreachable/unprovisioned database while treating real migration failures
 * as fatal.
 */
export async function runNamespacedMigrations({
  connectionString,
  schemaName,
  dirAbs,
  namespace,
  direction = "up",
  count,
  fake = false,
  allowSymlinks = false,
  missingDirHint,
  log = console.log,
}) {
  if (!connectionString) throw new Error("[migrations] connectionString is required");
  if (!schemaName) throw new Error("[migrations] schemaName is required");
  assertValidNamespace(namespace);
  if (direction !== "up" && direction !== "down") {
    throw new Error(`[migrations] unsupported direction "${direction}"`);
  }

  await validateNamespacedMigrationsDir(dirAbs, { namespace, allowSymlinks, missingDirHint });

  const { default: pg } = await import("pg");
  const { runner } = await import("node-pg-migrate");

  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
  } catch (error) {
    // Tag connection-phase failures: the database being unreachable is a
    // different beast from a migration failing (callers distinguish).
    error.phase = "connect";
    throw error;
  }

  try {
    // Serialize against bootstrap DDL + every other migration source on the
    // shared database-global key. Session-scoped: dies with this dedicated
    // session. Bounded wait so a wedged lock holder surfaces as a clear
    // timeout instead of an indefinite hang (parity with the bootstrap's budget).
    await client.query(`SET statement_timeout = ${CORE_MIGRATION_LOCK_TIMEOUT_MS}`);
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [CORE_MIGRATION_LOCK_KEY]);
    // Migrations own their runtime; do not cap long backfills.
    await client.query("RESET statement_timeout");

    if (direction === "down") {
      const fenceCount = Math.abs(count ?? 1);
      const ledger = `${quoteIdent(schemaName)}.${quoteIdent(CORE_MIGRATIONS_TABLE)}`;
      const exists = await client.query("SELECT to_regclass($1) AS t", [ledger]);
      if (!exists.rows[0]?.t) {
        log(`[${namespaceLabel(namespace)}-migrations] no ledger table — nothing to revert`);
        return { ranNames: [], direction, faked: false };
      }
      const last = await client.query(
        `SELECT name FROM ${ledger} ORDER BY run_on DESC, id DESC LIMIT $1`,
        [fenceCount],
      );
      assertDownTargetsInNamespace(
        last.rows.map((r) => r.name),
        namespace,
      );
    }

    const ran = await runner({
      dbClient: client,
      dir: dirAbs,
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
      logger: buildRunnerLogger(log, namespaceLabel(namespace)),
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
 * Run the core migration chain (stable #116 surface — thin wrapper over
 * {@link runNamespacedMigrations}).
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
  return runNamespacedMigrations({
    connectionString,
    schemaName,
    dirAbs: path.resolve(rootDir, CORE_MIGRATIONS_DIR),
    namespace: CORE_MIGRATION_NAMESPACE,
    direction,
    ...(count !== undefined ? { count } : {}),
    fake,
    allowSymlinks: true,
    missingDirHint:
      "the migrations/core directory must ship with the app (Dockerfile copies migrations/ into the runtime image)",
    log,
  });
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
