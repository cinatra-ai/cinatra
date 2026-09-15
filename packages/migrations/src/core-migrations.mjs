// Schema migration runner — node-pg-migrate, driven programmatically.
//
// THE canonical implementation for cinatra#116 + #118 (umbrella #115: one
// migration engine org-wide). Consumers share it so the options can never drift:
//   - `cinatra setup dev|prod` / `setup branch` (the @cinatra-ai/cinatra CLI),
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

// ===========================================================================
// THE EXTENSION MIGRATION ROAD (cinatra#3031, epic #3023 W7; plan (C) enabler
// 0.23, technical note 8.3).
//
// Here rather than in a module of its own, deliberately: plan (C) §8.1 names
// THIS file as where the runner change lands, and the runner is already
// reachable from four route-graph-ratcheted routes whose ceilings may only ever
// shrink — a sibling module would have grown all four by one for a road that
// belongs beside `runNamespacedMigrations`, whose credential model it splits.
// ===========================================================================

/** The ledger states this road writes. NULL means the historical `applied`. */// The EXTENSION migration road: the host keeps the lock and the ledger under
// its own credential, and switches to the extension's own database role around
// the extension's statements (cinatra#3031, epic #3023 W7; plan (C) enabler
// 0.23, technical note 8.3).
//
// WHAT WAS TRUE BEFORE. `runNamespacedMigrations` opens one dedicated client on
// the host's connection string, takes the one database-wide advisory lock,
// runs the extension's modules UNDER THE HOST ROLE — no role is switched
// anywhere in the tree — and lets node-pg-migrate write the shared
// `pgmigrations` ledger on that same client and transaction. So an extension's
// migration was arbitrary SQL under the host's own credential: nothing but the
// signature gate stood between a "data migration" and the whole application
// schema.
//
// WHAT IS TRUE NOW. Enabler 0.23: "an extension's own migrations are data
// migrations on its declared tables: they run under a database role of the
// extension's own that holds privileges on its prefixed tables and nothing
// else, so a statement that touches another table, another extension's table
// or the ledger is refused by the database itself, transaction or no
// transaction, and the host records the refusal on the migration's ledger
// row."
//
// HOW THE SPLIT IS MADE. node-pg-migrate takes ONE client and interleaves the
// migration's own statements with the ledger's. So the client it is handed here
// is a PROXY that classifies each statement by EXACT MATCH against the
// statements the library itself issues:
//
//   * the library's own ledger statements and the transaction control around
//     them run on the raw client, under the HOST role;
//   * the library's mark-as-run INSERT is replaced by the host's OWN
//     parameterized insert, carrying the `applied` state — the plan's "the host
//     writes the ledger row for an extension migration itself". It runs inside
//     the SAME transaction as the migration body, so a migration and its ledger
//     row still commit together;
//   * the library's "which migrations have run" SELECT is rewritten to ignore
//     REFUSED rows, so a refusal is recorded without pretending the migration
//     ran;
//   * EVERYTHING ELSE — which is the extension's own statements, and nothing
//     else — runs between `SET ROLE <extension role>` and `RESET ROLE`.
//
// Exact match, not "mentions the ledger": a migration that spells its own
// `INSERT INTO … pgmigrations …` differently by one byte falls through to the
// extension role and is refused by the database, which is the point. A
// migration that copies the library's mark-as-run byte for byte is intercepted
// into the host's own insert for a name already in this run's pending set, so
// it can forge nothing.
//
// THE LEDGER STAYS ONE LEDGER. `state` and `refused_reason` are additive
// nullable columns on `pgmigrations` (NULL = the historical `applied`), ensured
// idempotently here for a database whose ledger predates them and recorded in
// the versioned history by `migrations/core/core__0098_*`.


export const EXTENSION_MIGRATION_STATE_APPLIED = "applied";
export const EXTENSION_MIGRATION_STATE_REFUSED = "refused";

/**
 * The exact statements node-pg-migrate issues against the ledger, built the way
 * the library builds them (`dist/legacy/runner.js`, `dist/legacy/migration.js`).
 * @param {string} schemaName
 */
export function ledgerStatementSet(schemaName) {
  const full = `"${schemaName}"."${CORE_MIGRATIONS_TABLE}"`;
  return {
    full,
    existsProbe: `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schemaName}' AND table_name = '${CORE_MIGRATIONS_TABLE}'`,
    primaryKeyProbe: `SELECT constraint_name FROM information_schema.table_constraints WHERE table_schema = '${schemaName}' AND table_name = '${CORE_MIGRATIONS_TABLE}' AND constraint_type = 'PRIMARY KEY'`,
    addPrimaryKey: `ALTER TABLE ${full} ADD PRIMARY KEY (id)`,
    createTable: `CREATE TABLE ${full} (id SERIAL PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)`,
    runNamesSelect: `SELECT name FROM ${full} ORDER BY run_on, id`,
    markAsRun: (name) => `INSERT INTO ${full} (name, run_on) VALUES ('${name}', NOW());`,
    // The two session statements the library issues before the ledger exists
    // (`dist/legacy/runner.js`), built the way it builds them so they can be
    // matched EXACTLY rather than by prefix.
    setSearchPath: `SET search_path TO "${schemaName}"`,
    createSchemaIfNotExists: `CREATE SCHEMA IF NOT EXISTS "${schemaName}"`,
  };
}

/**
 * The transaction control the library wraps a migration body in
 * (`dist/legacy/migration.js` unshifts `BEGIN;` and pushes `COMMIT;`), matched
 * as a WHOLE statement.
 *
 * A prefix test was the first spelling of this and it was wrong: `RESET ROLE;
 * DELETE FROM "cinatra"."objects"` begins with `reset ` and PostgreSQL's simple
 * query protocol runs both halves, so a prefix match would have handed an
 * extension's migration the host credential for arbitrary SQL. Nothing is
 * classified as host control unless it equals one of these, and a statement
 * carrying a second statement is never host control at all.
 */
const TRANSACTION_CONTROL = new Set([
  "begin",
  "begin work",
  "begin transaction",
  "commit",
  "commit work",
  "commit transaction",
  "rollback",
  "rollback work",
  "rollback transaction",
]);

/**
 * Classify ONE statement the runner issues.
 *
 * @param {string} sql
 * @param {object} ctx
 * @param {ReturnType<typeof ledgerStatementSet>} ctx.ledger
 * @param {Set<string>} ctx.pendingNames the run's pending modules IN ORDER; only the
 *   FIRST may be marked as run (the client removes it once the host has)
 * @returns {{kind:"host"}|{kind:"run-names-select"}|{kind:"mark-as-run", name:string}|{kind:"extension"}}
 */
export function classifyExtensionMigrationStatement(sql, { ledger, pendingNames }) {
  const text = String(sql ?? "").trim();
  // Strip trailing statement separators without a quantified regex against
  // uncontrolled input (CodeQL js/polynomial-redos): a bounded loop is linear
  // and behaves identically to the /;+$/ it replaces.
  let bare = text;
  while (bare.endsWith(";")) bare = bare.slice(0, -1);
  bare = bare.trim();
  // A statement that carries a SECOND statement is the extension's, whatever
  // its first word is: the host side of this classifier must never run text it
  // has not matched in full.
  if (bare.includes(";")) return { kind: "extension" };
  if (TRANSACTION_CONTROL.has(bare.toLowerCase())) return { kind: "host" };
  if (
    bare === ledger.existsProbe ||
    bare === ledger.primaryKeyProbe ||
    bare === ledger.addPrimaryKey ||
    bare === ledger.createTable ||
    bare === ledger.setSearchPath ||
    bare === ledger.createSchemaIfNotExists
  ) {
    return { kind: "host" };
  }
  if (bare === ledger.runNamesSelect) return { kind: "run-names-select" };
  // ONLY the next pending module may be marked as run. node-pg-migrate applies
  // the pending chain in order and marks each module immediately after it, so
  // the next one is the only name it can legitimately write; accepting any
  // name in the pending set let migration 0001 emit the ledger INSERT for 0002
  // and have the host write it, after which a process that stopped between the
  // two would read 0002 as applied and never run it.
  const next = pendingNames.values().next();
  if (!next.done) {
    const name = next.value;
    if (text === ledger.markAsRun(name) || bare === ledger.markAsRun(name).replace(/;$/, "")) {
      return { kind: "mark-as-run", name };
    }
  }
  return { kind: "extension" };
}

/**
 * Strip what a role-change word could hide behind — line and block comments and
 * single-quoted literals — so the check below reads only executable text.
 * @param {string} sql
 */
function executableText(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** A statement that changes the role or the session authorization. */
const ROLE_CHANGE_RE =
  /\b(?:set|reset)\s+(?:local\s+|session\s+)?(?:role|session\s+authorization|authorization)\b/i;

/**
 * The one thing `SET ROLE` cannot defend against is `RESET ROLE`: it is a
 * SESSION-level switch, and the extension's own statement runs in that same
 * session, so a migration that begins by resetting the role would run
 * everything after it under the host credential. The host therefore REFUSES
 * such a statement outright — it is recorded on the ledger as a refusal like
 * any other, and nothing of the migration runs.
 *
 * This is a guard on the statement TEXT, which is weaker than a boundary the
 * database enforces; the durable form is a separate connection authenticated AS
 * the extension role, which needs a LOGIN role and a credential for it and is
 * therefore not this slice's to build. Recorded as a deviation rather than
 * left to be discovered. (A `DO` block cannot be used to smuggle one: PostgreSQL
 * reverts a SET issued inside a function or DO block when it exits.)
 *
 * @param {string} sql
 */
export function assertExtensionStatementKeepsItsRole(sql) {
  if (ROLE_CHANGE_RE.test(executableText(String(sql ?? "")))) {
    throw new Error(
      "[ext-migrations] refused: an extension migration may not change the role it runs as " +
        "(SET ROLE / SET SESSION AUTHORIZATION) — its statements run under the extension's own " +
        "database role and nothing else",
    );
  }
}

/**
 * The role-switching client node-pg-migrate is handed.
 *
 * @param {object} input
 * @param {{query: Function}} input.raw the host's own pg client
 * @param {string} input.roleName the extension's database role
 * @param {ReturnType<typeof ledgerStatementSet>} input.ledger
 * @param {Set<string>} input.pendingNames the run's pending modules in order (mutated)
 * @param {string[]} input.markedAsRun mutated: names the host wrote a ledger row for
 */
export function createExtensionRoleClient({ raw, roleName, ledger, pendingNames, markedAsRun }) {
  const role = quoteIdent(roleName);
  return {
    async query(textOrConfig, values) {
      const text =
        typeof textOrConfig === "string" ? textOrConfig : String(textOrConfig?.text ?? "");
      const verdict = classifyExtensionMigrationStatement(text, { ledger, pendingNames });
      if (verdict.kind === "host") {
        return raw.query(textOrConfig, values);
      }
      if (verdict.kind === "run-names-select") {
        // A REFUSED row records that a migration was attempted and denied; it
        // must never read as "already run", or the refusal would silently skip
        // the migration forever.
        return raw.query(
          `SELECT name FROM ${ledger.full} WHERE state IS DISTINCT FROM $1 ORDER BY run_on, id`,
          [EXTENSION_MIGRATION_STATE_REFUSED],
        );
      }
      if (verdict.kind === "mark-as-run") {
        // The HOST writes the extension's ledger row itself, under the host
        // role, inside the migration's own transaction.
        const res = await raw.query(
          `INSERT INTO ${ledger.full} (name, run_on, state) VALUES ($1, NOW(), $2)`,
          [verdict.name, EXTENSION_MIGRATION_STATE_APPLIED],
        );
        markedAsRun.push(verdict.name);
        // Spent: the next module is now the only one this run may mark.
        pendingNames.delete(verdict.name);
        return res;
      }
      // The extension's own statement. Everything it may touch, the database
      // decides — provided it cannot step out of the role first.
      assertExtensionStatementKeepsItsRole(text);
      await raw.query(`SET ROLE ${role}`);
      try {
        return await raw.query(textOrConfig, values);
      } finally {
        // In an aborted transaction this itself raises 25P02; the ROLLBACK the
        // caller issues restores the role either way (SET is transactional).
        await raw.query("RESET ROLE").catch(() => {});
      }
    },
  };
}

/**
 * Ensure the ledger carries the two additive state columns. Idempotent, host
 * role, and safe on a ledger that predates them (NULL = the historical
 * `applied`). The operator-upgrade twin is `core__0098`.
 * @param {{query: Function}} raw
 * @param {string} schemaName
 */
export async function ensureExtensionLedgerStateColumns(raw, schemaName) {
  const full = `${quoteIdent(schemaName)}.${quoteIdent(CORE_MIGRATIONS_TABLE)}`;
  // The ledger is created here rather than left to node-pg-migrate's own
  // `ensureMigrationsTable`, which runs INSIDE the runner — after which the
  // host's first ledger write would be the first statement to discover the
  // state column is missing. Same three columns, byte for byte the library's
  // own DDL (`dist/legacy/runner.js`), so a database that already has the table
  // sees a no-op and one that does not lands on exactly the shape the library
  // would have made.
  await raw.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
  await raw.query(
    `CREATE TABLE IF NOT EXISTS ${full} (id SERIAL PRIMARY KEY, name varchar(255) NOT NULL, run_on timestamp NOT NULL)`,
  );
  await raw.query(`ALTER TABLE ${full} ADD COLUMN IF NOT EXISTS state text`);
  await raw.query(`ALTER TABLE ${full} ADD COLUMN IF NOT EXISTS refused_reason text`);
}

/**
 * Run ONE extension's migration chain with the credential split of 8.3.
 *
 * @param {object} input
 * @param {string} input.connectionString
 * @param {string} input.schemaName
 * @param {string} input.dirAbs
 * @param {string} input.namespace per-source ledger namespace incl. trailing `__`
 * @param {string} input.roleName the extension's own database role (must exist)
 * @param {(msg:string)=>void} [input.log]
 * @returns {Promise<{ranNames: string[]}>}
 */
export async function runExtensionMigrationsUnderRole({
  connectionString,
  schemaName,
  dirAbs,
  namespace,
  roleName,
  log = console.log,
}) {
  if (!connectionString) throw new Error("[ext-migrations] connectionString is required");
  if (!schemaName) throw new Error("[ext-migrations] schemaName is required");
  if (!roleName) throw new Error("[ext-migrations] roleName is required");
  assertValidNamespace(namespace);
  const label = namespaceLabel(namespace);

  const files = await validateNamespacedMigrationsDir(dirAbs, {
    namespace,
    allowSymlinks: false,
  });
  const allNames = files.map((f) => path.basename(f, ".mjs"));

  const { default: pg } = await import("pg");
  const { runner } = await import("node-pg-migrate");

  const raw = new pg.Client({ connectionString });
  try {
    await raw.connect();
  } catch (error) {
    error.phase = "connect";
    throw error;
  }

  const ledger = ledgerStatementSet(schemaName);
  const markedAsRun = [];
  try {
    await raw.query(`SET statement_timeout = ${CORE_MIGRATION_LOCK_TIMEOUT_MS}`);
    await raw.query("SELECT pg_advisory_lock(hashtext($1))", [CORE_MIGRATION_LOCK_KEY]);
    await raw.query("RESET statement_timeout");

    // The role must EXIST before anything runs: an absent role would silently
    // fall back to the host's own credential, which is the hole this closes.
    const roleRow = await raw.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [roleName]);
    if (roleRow.rowCount === 0) {
      throw new Error(
        `[${label}-migrations] the extension database role "${roleName}" does not exist — ` +
          `the host creates it from the declared tables before any migration runs; refusing to ` +
          `run extension statements under the host credential`,
      );
    }

    await ensureExtensionLedgerStateColumns(raw, schemaName);

    // The PENDING set for THIS run: the declared modules the ledger does not
    // already carry as applied. It is what the mark-as-run interception is
    // bounded by, and it is what names the module a refusal belongs to — the
    // first pending one this run did not get to mark. Reading it here rather
    // than assuming "every declared module" is what keeps a second run's
    // refusal on the module that was actually refused instead of on the one
    // that succeeded a run earlier.
    const alreadyRun = await raw.query(
      `SELECT name FROM ${ledger.full} WHERE state IS DISTINCT FROM $1`,
      [EXTENSION_MIGRATION_STATE_REFUSED],
    );
    const applied = new Set(alreadyRun.rows.map((r) => r.name));
    const pending = allNames.filter((n) => !applied.has(n));
    const pendingNames = new Set(pending);
    const proxy = createExtensionRoleClient({
      raw,
      roleName,
      ledger,
      pendingNames,
      markedAsRun,
    });

    try {
      const ran = await runner({
        dbClient: proxy,
        dir: dirAbs,
        migrationsTable: CORE_MIGRATIONS_TABLE,
        schema: schemaName,
        createSchema: true,
        noLock: true,
        checkOrder: false,
        direction: "up",
        verbose: false,
        logger: {
          debug: undefined,
          info: (m) => log(`[${label}-migrations] ${m}`),
          warn: (m) => log(`[${label}-migrations] warn: ${m}`),
          error: (m) => log(`[${label}-migrations] error: ${m}`),
        },
      });
      return { ranNames: ran.map((m) => m.name) };
    } catch (error) {
      // The library leaves the failed migration's transaction OPEN and aborted
      // when it is not running in single-transaction mode; roll it back before
      // the host records anything, or the refusal row would be discarded with
      // it.
      await raw.query("ROLLBACK").catch(() => {});
      await raw.query("RESET ROLE").catch(() => {});
      const reason = error instanceof Error ? error.message : String(error);
      const refusedName = pending.find((n) => !markedAsRun.includes(n)) ?? null;
      if (refusedName) {
        await raw
          .query(
            `INSERT INTO ${ledger.full} (name, run_on, state, refused_reason) VALUES ($1, NOW(), $2, $3)`,
            [refusedName, EXTENSION_MIGRATION_STATE_REFUSED, reason.slice(0, 4000)],
          )
          .catch(() => {});
        log(
          `[${label}-migrations] recorded the refusal of ${refusedName} on the shared ledger: ${reason}`,
        );
      }
      throw error;
    }
  } finally {
    try {
      await raw.end();
    } catch {
      /* the session dies with the process either way */
    }
  }
}
