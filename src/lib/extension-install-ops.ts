import "server-only";

// Install-op JOURNAL store for the runtime extension installer (cinatra#158).
//
// APPEND-ONLY, ONE ROW PER ATTEMPT (keyed by `install_op_id`, the PK). Each
// install attempt for a (package, org) appends its OWN row; a new attempt NEVER
// destroys the prior attempt's row. The "trusted install" of a (package, org) is
// the SINGLE `finalized` op, enforced at the DB layer by a PARTIAL UNIQUE index
// `(package_name, org_id) WHERE phase = 'finalized'` — so there is provably AT
// MOST ONE finalized op per (package, org) at any time. That single finalized op
// IS the install anchor (`resolveInstallAnchor` reads it via `readInstallOp`).
//
// SUPERSESSION (the happy path): a SUCCESSFUL re-install/update finalizes a NEW
// op — `finalizeInstallOp` demotes the prior finalized op to the terminal
// `superseded` phase and promotes the new op to `finalized`, ATOMICALLY in one
// transaction (the partial unique index serializes concurrent finalizes; a
// 23505 conflict retries the demote-then-promote). A FAILED update simply leaves
// the NEW op terminalized (`failed`/`rolled_back`) and NEVER demotes OLD — so the
// OLD finalized op stays the anchor with ZERO journal restore (this is why the
// pre-cinatra#158 re-begin/re-finalize "restore choreographies" were deleted).
//
// PRE-RELEASE DEPLOY NOTE (cinatra#158 — coordinated, NON-rolling migration
// boundary): migration `core__0005` drops the OLD full unique indexes
// (`extension_install_ops_pkg_org_uniq` / `_pkg_global_uniq`) and adds the
// partial-finalized unique indexes. PRE-0005 code did a reset-on-begin UPDATE
// keyed by `(package_name, org_id)`; once the full unique indexes are gone, that
// old UPDATE could touch MULTIPLE appended rows. So 0005 must be applied with OLD
// writers drained (a coordinated deploy, not a rolling one where pre-0005 and
// post-0005 app processes write the journal concurrently). cinatra is a single
// writable install region per deploy; the install path is additionally serialized
// per-package in-process (`withInstallLock`).
//
// Reads/writes go through an INJECTED query so the store is unit-testable
// without a DB. The default path is a lazy, globalThis-cached `pg.Pool` (NEVER a
// top-level pool — that would break `next build` page-data collection). The
// supersession transaction uses a checked-out client (`withClient`); the injected
// query path runs the demote + promote as two ordered statements (tests assert
// the ordering against an in-memory fake).

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/** The ordered install-op phases (the saga advances through these). */
export const INSTALL_OP_PHASES = [
  "materialized",
  "granted",
  "preflighted",
  // `writing` marks the dashboard-write region (set the moment the saga enters
  // it). Boot-orphan cleanup archives dashboards ONLY for an op that reached
  // `writing` — so a crashed re-install that died earlier never archives a
  // previous healthy install's dashboards.
  "writing",
  "finalized",
  "failed",
  "rolled_back",
  // cinatra#158: a prior `finalized` op demoted by a SUCCESSFUL newer install's
  // `finalizeInstallOp` supersession. Terminal (never swept, never the anchor).
  "superseded",
] as const;
export type InstallOpPhase = (typeof INSTALL_OP_PHASES)[number];

/** Minimal async query surface (injected → unit-testable without a DB). */
export type InstallOpsQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

/**
 * Run `fn` inside a SERIALIZED unit (a DB transaction on the default path) using
 * a single query handle. `finalizeInstallOp`'s demote-then-promote supersession
 * MUST run atomically so the partial-unique-on-`finalized` invariant holds under
 * concurrent finalizes; the default path opens a `BEGIN…COMMIT` on a checked-out
 * client, and the injected (test) path runs `fn` against the same in-memory fake
 * query so the demote/promote ordering is exercised without a Postgres.
 */
export type InstallOpsTransaction = <R>(fn: (q: InstallOpsQuery) => Promise<R>) => Promise<R>;

export type InstallOpsDeps = {
  query: InstallOpsQuery;
  /**
   * Optional serialized-transaction runner (the supersession seam). When omitted
   * the default factory wraps the lazy pool with a `BEGIN/COMMIT` client; an
   * injected `query` without `withTransaction` runs the unit non-atomically
   * against the same fake (acceptable for unit tests — there is no real
   * concurrency in a single-threaded fake).
   */
  withTransaction?: InstallOpsTransaction;
  /** The host schema the journal lives in (default `cinatra`). */
  schema?: string;
};

// ---------------------------------------------------------------------------
// Lazy default DB query path (globalThis-cached pool — never a top-level pool,
// to keep `next build` page-data collection from throwing without a DB URL).
// ---------------------------------------------------------------------------

declare global {
  // eslint-disable-next-line no-var
  var __cinatraInstallOpsPool: import("pg").Pool | undefined;
}

let installOpsPoolInstance: import("pg").Pool | undefined;
async function getInstallOpsPool(): Promise<import("pg").Pool> {
  if (installOpsPoolInstance) return installOpsPoolInstance;
  if (globalThis.__cinatraInstallOpsPool) {
    return (installOpsPoolInstance = globalThis.__cinatraInstallOpsPool);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error("SUPABASE_DB_URL is required for @/lib/extension-install-ops");
  }
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString });
  if (!pool.listenerCount("error")) {
    pool.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error("[extension-install-ops] pg pool idle client error:", err.message);
    });
  }
  installOpsPoolInstance = pool;
  if (process.env.NODE_ENV !== "production") {
    globalThis.__cinatraInstallOpsPool = pool;
  }
  return pool;
}

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getInstallOpsPool();
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

/**
 * Default supersession transaction: check a client out of the lazy pool, run
 * `BEGIN … COMMIT` (ROLLBACK on throw), and expose its `client.query` to `fn`.
 */
async function defaultWithTransaction<R>(fn: (q: InstallOpsQuery) => Promise<R>): Promise<R> {
  const pool = await getInstallOpsPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const clientQuery: InstallOpsQuery = async <T,>(text: string, values?: readonly unknown[]) => {
      const result = await client.query(text, values ? [...values] : undefined);
      return result.rows as T[];
    };
    const out = await fn(clientQuery);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function resolveDeps(deps?: InstallOpsDeps): Promise<{
  query: InstallOpsQuery;
  withTransaction: InstallOpsTransaction;
  schema: string;
}> {
  const query = deps?.query ?? defaultQuery;
  return {
    query,
    // No injected runner: on the DEFAULT path use a real client transaction; on
    // an injected (test) `query` with no `withTransaction`, run the unit against
    // the SAME fake query (no real concurrency to serialize in a fake).
    withTransaction:
      deps?.withTransaction ??
      (deps?.query ? (async (fn) => fn(query)) : defaultWithTransaction),
    schema: deps?.schema ?? schemaName,
  };
}

function qualifiedTable(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."extension_install_ops"`;
}

/**
 * `org_id` is nullable; a plain `WHERE org_id = $n` never matches a NULL row, so
 * the global (org_id IS NULL) journal row needs an `IS NULL` clause. Mirrors the
 * host-port-grant store's org-vs-global handling.
 */
function orgClause(orgId: string | null, paramIndex: number): { clause: string; value: string | null } {
  return orgId === null
    ? { clause: "org_id IS NULL", value: null }
    : { clause: `org_id = $${paramIndex}`, value: orgId };
}

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

type InstallOpRow = {
  install_op_id: string;
  package_name: string;
  org_id: string | null;
  phase: string;
  digest: string | null;
  started_at: string;
  updated_at: string;
};

export type InstallOp = {
  installOpId: string;
  packageName: string;
  orgId: string | null;
  phase: InstallOpPhase;
  digest: string | null;
  startedAt: string;
  updatedAt: string;
};

function rowToInstallOp(row: InstallOpRow): InstallOp {
  return {
    installOpId: row.install_op_id,
    packageName: row.package_name,
    orgId: row.org_id,
    phase: row.phase as InstallOpPhase,
    digest: row.digest,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = "install_op_id, package_name, org_id, phase, digest, started_at, updated_at";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type BeginInstallOpInput = {
  installOpId: string;
  packageName: string;
  orgId: string | null;
  /** Initial phase; defaults to `materialized` (the first saga step). */
  phase?: InstallOpPhase;
  digest?: string | null;
};

/**
 * Begin the install op for a (package, org) — APPEND-ONLY (cinatra#158). INSERTs
 * a NEW per-attempt row at a NON-terminal phase (default `materialized`); it
 * NEVER touches sibling rows for the same (package, org), so a fresh attempt can
 * never destroy the prior attempt's (possibly `finalized`) row.
 *
 * Idempotent ONLY on a re-begin of the SAME `install_op_id` (a retry/resume of
 * the same attempt): `ON CONFLICT (install_op_id) DO UPDATE` resets that one
 * row's phase/digest/timestamps. A DIFFERENT op id always appends a fresh row.
 *
 * The begin phase must NOT be `finalized` (the partial-unique-on-finalized
 * invariant is owned exclusively by `finalizeInstallOp`'s supersession seam);
 * passing `finalized` here is rejected fail-closed.
 *
 * TERMINAL-PRESERVING (cinatra#158 — codex diff finding): the ON CONFLICT update
 * NEVER DOWNGRADES a row that already reached a TERMINAL phase
 * (`finalized`/`superseded`/`failed`/`rolled_back`). A duplicate/resumed begin
 * with the SAME op id after a successful finalize would otherwise flip the only
 * anchor back to `materialized` and leave the package with no trusted anchor. A
 * conflict on a terminal row is a NO-OP that returns the preserved row.
 */
export async function beginInstallOp(
  input: BeginInstallOpInput,
  deps?: InstallOpsDeps,
): Promise<InstallOp> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const phase = input.phase ?? "materialized";
  if (phase === "finalized") {
    throw new Error(
      "beginInstallOp cannot begin at 'finalized' — finalize is the supersession seam (finalizeInstallOp)",
    );
  }
  const rows = await query<InstallOpRow>(
    `INSERT INTO ${table} (install_op_id, package_name, org_id, phase, digest)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (install_op_id) DO UPDATE
       SET phase = EXCLUDED.phase,
           digest = EXCLUDED.digest,
           started_at = now(),
           updated_at = now()
       WHERE ${table}.phase NOT IN ('finalized', 'superseded', 'failed', 'rolled_back')
     RETURNING ${SELECT_COLUMNS}`,
    [input.installOpId, input.packageName, input.orgId, phase, input.digest ?? null],
  );
  if (rows[0]) return rowToInstallOp(rows[0]);
  // No RETURNING row: either the conflict hit a TERMINAL row (the WHERE skipped the
  // update — preserve + return it) or, defensively, a lost insert. Re-read by id.
  const existing = await query<InstallOpRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE install_op_id = $1 LIMIT 1`,
    [input.installOpId],
  );
  if (!existing[0]) throw new Error("extension_install_ops begin returned no row");
  return rowToInstallOp(existing[0]);
}

export type AdvanceInstallOpInput = {
  installOpId: string;
  phase: InstallOpPhase;
  digest?: string | null;
};

/**
 * Advance the named install op to a new phase. Idempotent re-application of the
 * SAME phase is a no-op write (still returns the row). Matches by install_op_id
 * so a stale op can never advance a newer attempt's row.
 */
export async function advanceInstallOpPhase(
  input: AdvanceInstallOpInput,
  deps?: InstallOpsDeps,
): Promise<InstallOp> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const setDigest = input.digest !== undefined;
  const values: unknown[] = setDigest
    ? [input.phase, input.digest, input.installOpId]
    : [input.phase, input.installOpId];
  const rows = await query<InstallOpRow>(
    `UPDATE ${table}
       SET phase = $1,
           ${setDigest ? "digest = $2," : ""}
           updated_at = now()
     WHERE install_op_id = $${setDigest ? 3 : 2}
     RETURNING ${SELECT_COLUMNS}`,
    values,
  );
  if (!rows[0]) {
    throw new Error(`extension_install_ops advance: no row for install_op_id ${input.installOpId}`);
  }
  return rowToInstallOp(rows[0]);
}

/**
 * Finalize the op — the SUPERSESSION seam (cinatra#158). The only phase the
 * trust gate accepts, and the only place the partial-unique-on-`finalized`
 * invariant is mutated. Runs ATOMICALLY in one transaction:
 *   (1) DEMOTE any OTHER currently-`finalized` op for the SAME (package, org) to
 *       the terminal `superseded` phase (the prior install legitimately replaced
 *       by this successful one), then
 *   (2) PROMOTE this op to `finalized`.
 * The partial unique index `(package_name, org_id) WHERE phase='finalized'`
 * serializes concurrent finalizes: a racing finalizer's promote (2) blocks/errors
 * (23505) until the first commits; on a 23505 we RETRY the demote-then-promote
 * (the just-committed peer is now the row we demote). Bounded retries; a
 * persistent conflict throws (fail-loud).
 */
export async function finalizeInstallOp(
  installOpId: string,
  deps?: InstallOpsDeps,
): Promise<InstallOp> {
  const { query, withTransaction, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);

  // Resolve the op's (package, org) scope so the demote targets exactly it.
  const self = (
    await query<InstallOpRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE install_op_id = $1 LIMIT 1`,
      [installOpId],
    )
  )[0];
  if (!self) {
    throw new Error(`extension_install_ops finalize: no row for install_op_id ${installOpId}`);
  }
  const orgId = self.org_id;

  const runOnce = async (): Promise<InstallOpRow> =>
    withTransaction(async (q) => {
      const { value } = orgClause(orgId, 2);
      // (1) DEMOTE the prior finalized op for this scope (if any), excluding self.
      const demoteValues: unknown[] = [installOpId];
      if (value !== null) demoteValues.push(value);
      await q(
        `UPDATE ${table}
           SET phase = 'superseded', updated_at = now()
         WHERE package_name = (SELECT package_name FROM ${table} WHERE install_op_id = $1)
           AND ${value === null ? "org_id IS NULL" : "org_id = $2"}
           AND phase = 'finalized'
           AND install_op_id <> $1`,
        demoteValues,
      );
      // (2) PROMOTE self to finalized.
      const promoted = await q<InstallOpRow>(
        `UPDATE ${table}
           SET phase = 'finalized', updated_at = now()
         WHERE install_op_id = $1
         RETURNING ${SELECT_COLUMNS}`,
        [installOpId],
      );
      if (!promoted[0]) {
        throw new Error(`extension_install_ops finalize: no row for install_op_id ${installOpId}`);
      }
      return promoted[0];
    });

  const MAX_RETRIES = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return rowToInstallOp(await runOnce());
    } catch (err) {
      // 23505 = unique_violation on the partial-finalized index: a racing
      // finalizer committed between our demote and promote. Retry — its now-
      // committed finalized row is what our next demote sweeps.
      const code = (err as { code?: string } | null)?.code;
      if (code !== "23505") throw err;
      lastErr = err;
    }
  }
  throw new Error(
    `extension_install_ops finalize: persistent finalized-uniqueness conflict for ${installOpId} after ${MAX_RETRIES} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/** Mark the op `failed` (the saga then unwinds; a later compensation sets `rolled_back`). */
export async function failInstallOp(
  installOpId: string,
  deps?: InstallOpsDeps,
): Promise<InstallOp> {
  return advanceInstallOpPhase({ installOpId, phase: "failed" }, deps);
}

/**
 * Read the ANCHOR install-op for a (package, org), or null (cinatra#158). The
 * trust gate (`resolveInstallAnchor`) + the `isUpdate` detection in the install
 * pipeline/saga + the batch ledger consume this. With the append-only journal it
 * returns the SINGLE `finalized` op when one exists (the install anchor — the
 * partial-unique index guarantees there is at most one); else the LATEST attempt
 * row overall (so a fresh-but-unfinalized install is still observed). Surfaces
 * `installOpId` + `digest` so callers can identify the finalized artifact (the
 * saga idempotency) and BIND the anchor's digest (the runtime loader asserts
 * `record.declaredDigest === anchor.digest` — fail-closed on an OLD-finalized-op
 * vs NEW-source residue).
 */
export async function readInstallOp(
  packageName: string,
  orgId: string | null,
  deps?: InstallOpsDeps,
): Promise<{ phase: InstallOpPhase; installOpId: string; digest: string | null } | null> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const { clause, value } = orgClause(orgId, 2);
  const values: unknown[] = [packageName];
  if (value !== null) values.push(value);
  // Prefer the finalized anchor (one, by the partial-unique invariant); else the
  // latest attempt. `phase = 'finalized'` sorts first, then most-recent.
  const rows = await query<InstallOpRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table}
      WHERE package_name = $1 AND ${clause}
      ORDER BY (phase = 'finalized') DESC, updated_at DESC, started_at DESC
      LIMIT 1`,
    values,
  );
  const row = rows[0] ?? null;
  return row
    ? { phase: row.phase as InstallOpPhase, installOpId: row.install_op_id, digest: row.digest }
    : null;
}

/**
 * Read the NON-FINALIZED-WINDOW signal for a (package, org), or null when there
 * is NO journal row at all (cinatra#158). This is the basis of
 * `isNonFinalizedLiveRowAware` (via `readExtensionInstallOpPhase`) — it answers
 * "is the live canonical row's install non-finalized / non-anchorable?". Distinct
 * from `readInstallOp` (the anchor reader): a terminalized `superseded`/`failed`/
 * `rolled_back` newer attempt must NOT make the retained OLD finalized install
 * look broken. Three-branch semantics:
 *   - a `finalized` op EXISTS for the scope → HEALTHY → returns `"finalized"`
 *     (the caller treats it as anchorable → NOT rollbackable);
 *   - else the LATEST op (any phase) for the scope → returns that phase (a fresh
 *     attempt mid-flight, OR an only-ever-terminal-never-finalized half-install
 *     that fully rolled back — BOTH are non-anchorable → rollbackable);
 *   - no journal row at all → null (the caller falls back to the integrity
 *     check). A read/store failure is the CALLER's concern — this never collapses
 *     a present-but-unreadable journal to null.
 */
export async function readLatestInstallOpPhase(
  packageName: string,
  orgId: string | null,
  deps?: InstallOpsDeps,
): Promise<InstallOpPhase | null> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const { clause, value } = orgClause(orgId, 2);
  const values: unknown[] = [packageName];
  if (value !== null) values.push(value);
  // Finalized-wins, else latest attempt — identical ordering to readInstallOp so
  // "finalized exists ⇒ healthy" holds; the difference is the consumer's intent.
  const rows = await query<InstallOpRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table}
      WHERE package_name = $1 AND ${clause}
      ORDER BY (phase = 'finalized') DESC, updated_at DESC, started_at DESC
      LIMIT 1`,
    values,
  );
  return rows[0] ? (rows[0].phase as InstallOpPhase) : null;
}

/** The phases that mean "this op is settled" — never candidates for cleanup. */
const TERMINAL_PHASES: ReadonlySet<InstallOpPhase> = new Set<InstallOpPhase>([
  "finalized",
  "failed",
  "rolled_back",
  // cinatra#158: a demoted prior anchor — settled, never swept.
  "superseded",
]);

/**
 * List install ops stuck in a NON-terminal phase
 * (`materialized`/`granted`/`preflighted`/`writing`) — i.e. an install the saga
 * began but never finalized or unwound (typically a process killed mid-install).
 * Boot-orphan cleanup reads these, runs the saga's compensation, and marks each
 * `rolled_back`.
 *
 * cinatra#158 (append-only): returns EVERY non-terminal op older than the
 * threshold — including >1 stuck attempt for the same (package, org) — and does
 * NOT exclude a (package, org) merely because a `finalized`/`superseded` anchor
 * also exists (those terminal phases are filtered by `phase <> ALL(terminal)`).
 * Compensation is idempotent, so compensating several stuck attempts for one
 * (package, org) in a single boot pass is safe; a healthy `finalized` anchor is
 * never swept (terminal). This keeps abandoned newer attempts operator-visible
 * rather than hiding them behind the retained anchor.
 *
 * `olderThanMs` (default 0 = all) filters by `updated_at` age so an install that
 * is currently in-flight in another worker is not swept; a positive threshold only
 * surfaces ops that have not advanced for that long.
 */
export async function listUnfinalizedInstallOps(
  olderThanMs = 0,
  deps?: InstallOpsDeps,
): Promise<InstallOp[]> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const terminal = [...TERMINAL_PHASES];
  const rows = await query<InstallOpRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table}
      WHERE phase <> ALL($1::text[])
        AND updated_at < (now() - ($2 || ' milliseconds')::interval)
      ORDER BY updated_at ASC`,
    [terminal, String(Math.max(0, olderThanMs))],
  );
  return rows.map(rowToInstallOp);
}
