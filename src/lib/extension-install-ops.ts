import "server-only";

// Install-op JOURNAL store for the runtime extension installer.
//
// One journal row per (package, org) records the live install's phase. The saga
// (a later slice) drives the phases — begin → materialized → granted →
// preflighted → finalized — with `failInstallOp`/`rolled_back` on the unwind
// path; THIS module owns the table + the phase transitions + the read the trust
// gate consumes. `resolveInstallAnchor` reads `readInstallOp` and treats any
// row whose phase is NOT `finalized` as non-anchorable (PRIMARY trust gate), so
// a crash mid-install never produces a trusted-anchorable row.
//
// Reads/writes go through an INJECTED query so the store is unit-testable
// without a DB. The default path is a lazy, globalThis-cached `pg.Pool` (NEVER a
// top-level pool — that would break `next build` page-data collection).

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
] as const;
export type InstallOpPhase = (typeof INSTALL_OP_PHASES)[number];

/** Minimal async query surface (injected → unit-testable without a DB). */
export type InstallOpsQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type InstallOpsDeps = {
  query: InstallOpsQuery;
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

async function resolveDeps(deps?: InstallOpsDeps): Promise<{
  query: InstallOpsQuery;
  schema: string;
}> {
  return {
    query: deps?.query ?? defaultQuery,
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

async function readRow(
  query: InstallOpsQuery,
  table: string,
  packageName: string,
  orgId: string | null,
): Promise<InstallOpRow | null> {
  const { clause, value } = orgClause(orgId, 2);
  const values: unknown[] = [packageName];
  if (value !== null) values.push(value);
  const rows = await query<InstallOpRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${table} WHERE package_name = $1 AND ${clause} LIMIT 1`,
    values,
  );
  return rows[0] ?? null;
}

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
 * Begin (or restart) the install op for a (package, org). Idempotent: a second
 * begin for the same (package, org) RESETS the existing journal row to the new
 * op id + phase (a fresh attempt supersedes a stale/crashed one) rather than
 * inserting a duplicate — so the (package, org) journal always reflects the
 * latest attempt, and the partial-unique index never trips.
 */
export async function beginInstallOp(
  input: BeginInstallOpInput,
  deps?: InstallOpsDeps,
): Promise<InstallOp> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const phase = input.phase ?? "materialized";
  const existing = await readRow(query, table, input.packageName, input.orgId);
  if (existing) {
    const { clause, value } = orgClause(input.orgId, 4);
    const values: unknown[] = [input.installOpId, phase, input.digest ?? null, input.packageName];
    if (value !== null) values.push(value);
    const rows = await query<InstallOpRow>(
      `UPDATE ${table}
         SET install_op_id = $1,
             phase = $2,
             digest = $3,
             started_at = now(),
             updated_at = now()
       WHERE package_name = $4 AND ${clause}
       RETURNING ${SELECT_COLUMNS}`,
      values,
    );
    if (!rows[0]) throw new Error("extension_install_ops begin update returned no row");
    return rowToInstallOp(rows[0]);
  }
  const rows = await query<InstallOpRow>(
    `INSERT INTO ${table} (install_op_id, package_name, org_id, phase, digest)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${SELECT_COLUMNS}`,
    [input.installOpId, input.packageName, input.orgId, phase, input.digest ?? null],
  );
  if (!rows[0]) throw new Error("extension_install_ops insert returned no row");
  return rowToInstallOp(rows[0]);
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

/** Mark the op `finalized` — the only phase the trust gate accepts. */
export async function finalizeInstallOp(
  installOpId: string,
  deps?: InstallOpsDeps,
): Promise<InstallOp> {
  return advanceInstallOpPhase({ installOpId, phase: "finalized" }, deps);
}

/** Mark the op `failed` (the saga then unwinds; a later compensation sets `rolled_back`). */
export async function failInstallOp(
  installOpId: string,
  deps?: InstallOpsDeps,
): Promise<InstallOp> {
  return advanceInstallOpPhase({ installOpId, phase: "failed" }, deps);
}

/**
 * Read the install-op journal row for a (package, org), or null. The trust gate
 * (`resolveInstallAnchor`) consumes `{ phase }` from this and refuses anything
 * not `finalized`. Also surfaces `installOpId` + `digest` so a caller can RESTORE
 * the prior finalized op on a failed hot-update (re-`begin` it at its original id
 * + digest, then re-`finalize` it — see the install pipeline's update-compensation
 * path). `digest` is already SELECTed by `readRow`; it was simply not returned.
 */
export async function readInstallOp(
  packageName: string,
  orgId: string | null,
  deps?: InstallOpsDeps,
): Promise<{ phase: InstallOpPhase; installOpId: string; digest: string | null } | null> {
  const { query, schema } = await resolveDeps(deps);
  const table = qualifiedTable(schema);
  const row = await readRow(query, table, packageName, orgId);
  // `installOpId` lets a caller distinguish WHICH artifact finalized (the saga's
  // idempotency must short-circuit only for the SAME (package, version) op, not
  // any finalized op for the package/org); `digest` lets the update-compensation
  // path re-create the prior finalized op identically when a hot-update fails.
  return row
    ? { phase: row.phase as InstallOpPhase, installOpId: row.install_op_id, digest: row.digest }
    : null;
}

/** The phases that mean "this op is settled" — never candidates for cleanup. */
const TERMINAL_PHASES: ReadonlySet<InstallOpPhase> = new Set<InstallOpPhase>([
  "finalized",
  "failed",
  "rolled_back",
]);

/**
 * List install ops stuck in a NON-terminal phase
 * (`materialized`/`granted`/`preflighted`) — i.e. an install the saga began but
 * never finalized or unwound (typically a process killed mid-install). Boot-orphan
 * cleanup reads these, runs the saga's compensation, and marks each `rolled_back`.
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
