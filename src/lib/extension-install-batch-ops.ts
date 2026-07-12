import "server-only";
import { getPooledDb } from "@/lib/db/pooled";

/**
 * The DURABLE capability-ownership DECLARATION CAPSULE for an
 * `install-side-by-side` member (cinatra#1040 S6). Declaration-only (what the
 * version declared, never a prior grant state — see
 * `extension-side-by-side-install` for the survivor-check-revoke reconcile and
 * why prior state is not restored). The TYPE lives HERE (the ledger that stores
 * it, already in the install route graph); the capsule helpers are inlined into
 * `extension-side-by-side-install` (no separate module) so nothing new enters a
 * locked route's reachable graph via the dynamic-import chain (route-graph-ratchet). */
export type SideBySideGrantCapsule = {
  /** Schema version of the capsule payload. */
  readonly v: 1;
  /** The widget-auth token ownership keys the version DECLARED (sorted/de-duped). */
  readonly declaredTokenKeys: string[];
};

// Install-BATCH ledger store (#180 PR-2).
//
// One row per dependency-batch install: the ROOT package plus the ordered,
// exact-pinned to-install member set the planner produced. The ledger WRAPS
// the per-member `extension_install_ops` journal rows: each member install
// still drives its own install-op (the anchor trust gate is unchanged); the
// batch row is the ONLY place the MEMBERSHIP + per-member pre-state +
// progress live, so mid-batch failure (or a crash) can be compensated
// precisely — newly-installed members rolled back, previously-present
// members untouched — from durable state alone.
//
// CONCURRENCY CONTRACT (converged design):
//  - ACTIVE-BATCH UNIQUENESS: at most one non-terminal batch per
//    (root_package, org) — enforced by a partial unique index.
//  - MEMBER-OVERLAP REFUSAL: a new batch whose planned set intersects ANY
//    active batch's planned set (same org scope) is refused — enforced by
//    `listActiveBatches` + the saga's pre-begin guard under the global
//    lifecycle lock. This is what keeps `beginInstallOp`'s reset-on-begin
//    semantics from orphaning a concurrent batch's member op.
//  - LOCK ORDER: the saga PLANS + BEGINS the batch under the GLOBAL extension
//    lifecycle lock, then installs members in topo order, each under its own
//    per-package install lock (the dispatcher acquires it) — never the
//    reverse, so batch-vs-batch and batch-vs-purge can not deadlock.
//
// Mirrors extension-install-ops.ts: injected query (unit-testable without a
// DB), lazy globalThis-cached pool, schema-qualified table.

const schemaName = process.env.SUPABASE_SCHEMA?.trim() || "cinatra";

/** Batch phases. `planning` and `installing` are the ACTIVE (non-terminal) phases. */
export const INSTALL_BATCH_PHASES = [
  "planning",
  "installing",
  "finalized",
  "failed",
  "compensated",
] as const;
export type InstallBatchPhase = (typeof INSTALL_BATCH_PHASES)[number];

export const ACTIVE_BATCH_PHASES: readonly InstallBatchPhase[] = ["planning", "installing"];

/** Per-member status inside the ledger. */
export type BatchMemberStatus =
  | "planned"
  | "already-installed"
  | "installing"
  | "installed"
  | "failed"
  | "compensated"
  | "compensation-failed";

/**
 * Durable PRE-STATE of a member, captured at plan time under the global
 * lifecycle lock — the compensation discriminator. `present: false` ⇒ this
 * batch installed it ⇒ compensation uninstalls it. `present: true` (it
 * already existed — e.g. the ROOT on a re-run) ⇒ compensation must NOT
 * remove it; the captured version/installOpId let a restore be precise.
 */
export type BatchMemberPreState = {
  present: boolean;
  version?: string;
  installOpId?: string;
  installOpPhase?: string;
};

export type InstallBatchMember = {
  packageName: string;
  /** Exact pin (closure pin on the gatekept path; resolved pin on the dev path). */
  version: string;
  /** Registry dispatch typeId the planner resolved for this member. */
  typeId: string;
  status: BatchMemberStatus;
  /**
   * How the saga realizes this member (#1039 Option B). Absent on legacy rows
   * (pre-#1039) ⇒ treated as `"install"`. An `"update"` member is a committed
   * dedupe-upward of a pre-existing shared dependency: it is ALWAYS a
   * `preState.present` member, so the newly-installed-only compensation loop
   * and the boot sweeper both skip it (never rolled back) — no per-field durable
   * restore is captured for it (that is the deferred Option A subsystem).
   *
   * An `"install-side-by-side"` member (cinatra#1040 S3) is a NEW NON-DEFAULT
   * version row of a package whose default stays installed — so its
   * `preState.present` is TRUE (package-scoped presence; a legacy sweeper that
   * predates this action therefore safely skips it), and BOTH the batch
   * compensation loop and the boot sweeper route it through the VERSION-SCOPED
   * side-by-side teardown instead of the package-scoped uninstall (which would
   * tear down the default install).
   */
  action?: "install" | "update" | "install-side-by-side";
  /**
   * For an `"install-side-by-side"` member: the RESOLVED conflict scope the
   * side-by-side row installs at (cinatra#1040 S3 / codex round-1) — may be
   * NULL (platform) when the org request fell back to the platform default.
   * The batch executor, compensation, and the boot sweeper all address this
   * scope, never the requesting actor's org.
   */
  scopeOrgId?: string | null;
  preState: BatchMemberPreState;
  /** The member's install-op id once its install began (journal linkage). */
  installOpId?: string;
  /** Failure/compensation detail for operators. */
  detail?: string;
  /**
   * cinatra#1040 S6: the DURABLE capability-ownership DECLARATION CAPSULE for an
   * `install-side-by-side` member — persisted BEFORE the member mutates the
   * shared ownership grant, so a later batch-compensation / boot-recovery
   * teardown reconciles the grant (survivor-check + revoke) even when this
   * version's store is gone. `null`/absent = no ownership was declared/mutated,
   * or the capsule has been RELEASED (spent: the member committed). Rides the
   * existing JSONB `members` column — NO schema change.
   */
  grantCapsule?: SideBySideGrantCapsule | null;
};

export type InstallBatch = {
  batchId: string;
  rootPackage: string;
  orgId: string | null;
  phase: InstallBatchPhase;
  /** Ordered DEPENDENCIES-FIRST; the root is the LAST member. */
  members: InstallBatchMember[];
  createdAt: string;
  updatedAt: string;
};

export type InstallBatchOpsQuery = <T = unknown>(
  text: string,
  values?: readonly unknown[],
) => Promise<T[]>;

export type InstallBatchOpsDeps = {
  query: InstallBatchOpsQuery;
  schema?: string;
};

// Lazy pool over the shared pool (@/lib/db/pooled, #303): created on first use,
// idle-error-listened, dev-cached. Kept async-returning so existing `await
// getPool()` call sites are unchanged.
async function getPool(): Promise<import("pg").Pool> {
  return getPooledDb({ name: "extension-install-batch-ops" });
}

async function defaultQuery<T = unknown>(
  text: string,
  values?: readonly unknown[],
): Promise<T[]> {
  const pool = await getPool();
  const result = await pool.query(text, values ? [...values] : undefined);
  return result.rows as T[];
}

async function resolveDeps(deps?: InstallBatchOpsDeps): Promise<{
  query: InstallBatchOpsQuery;
  schema: string;
}> {
  return { query: deps?.query ?? defaultQuery, schema: deps?.schema ?? schemaName };
}

function qualifiedTable(schema: string): string {
  return `"${schema.replaceAll('"', '""')}"."extension_install_batches"`;
}

type BatchRow = {
  batch_id: string;
  root_package: string;
  org_id: string | null;
  phase: string;
  members: InstallBatchMember[] | string;
  created_at: string;
  updated_at: string;
};

function rowToBatch(row: BatchRow): InstallBatch {
  return {
    batchId: row.batch_id,
    rootPackage: row.root_package,
    orgId: row.org_id,
    phase: row.phase as InstallBatchPhase,
    members:
      typeof row.members === "string"
        ? (JSON.parse(row.members) as InstallBatchMember[])
        : row.members,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_COLUMNS = "batch_id, root_package, org_id, phase, members, created_at, updated_at";

/**
 * Begin a batch in `planning`. The partial unique index refuses a second
 * ACTIVE batch for the same (root, org) at the DB level; the member-overlap
 * guard is the saga's (it must read ALL active batches first anyway).
 */
export async function beginInstallBatch(
  input: {
    batchId: string;
    rootPackage: string;
    orgId: string | null;
    members: InstallBatchMember[];
  },
  deps?: InstallBatchOpsDeps,
): Promise<InstallBatch> {
  const { query, schema } = await resolveDeps(deps);
  const rows = await query<BatchRow>(
    `INSERT INTO ${qualifiedTable(schema)} (batch_id, root_package, org_id, phase, members)
     VALUES ($1, $2, $3, 'planning', $4::jsonb)
     RETURNING ${SELECT_COLUMNS}`,
    [input.batchId, input.rootPackage, input.orgId, JSON.stringify(input.members)],
  );
  if (!rows[0]) throw new Error("extension_install_batches insert returned no row");
  return rowToBatch(rows[0]);
}

/** Advance the batch phase. */
export async function setInstallBatchPhase(
  batchId: string,
  phase: InstallBatchPhase,
  deps?: InstallBatchOpsDeps,
): Promise<InstallBatch> {
  const { query, schema } = await resolveDeps(deps);
  const rows = await query<BatchRow>(
    `UPDATE ${qualifiedTable(schema)}
       SET phase = $1, updated_at = now()
     WHERE batch_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [phase, batchId],
  );
  if (!rows[0]) throw new Error(`extension_install_batches: no row for batch ${batchId}`);
  return rowToBatch(rows[0]);
}

/**
 * Patch ONE member's ledger entry (status / installOpId / detail). Read-
 * modify-write on the jsonb members array keyed by packageName; the saga is
 * the only writer of an active batch (overlap guard + active-uniqueness), so
 * no concurrent-writer hazard exists on this row.
 */
export async function updateInstallBatchMember(
  batchId: string,
  packageName: string,
  patch: Partial<Pick<InstallBatchMember, "status" | "installOpId" | "detail" | "grantCapsule">>,
  deps?: InstallBatchOpsDeps,
): Promise<InstallBatch> {
  const { query, schema } = await resolveDeps(deps);
  const current = await readInstallBatch(batchId, deps);
  if (!current) throw new Error(`extension_install_batches: no row for batch ${batchId}`);
  const members = current.members.map((m) =>
    m.packageName === packageName ? { ...m, ...patch } : m,
  );
  const rows = await query<BatchRow>(
    `UPDATE ${qualifiedTable(schema)}
       SET members = $1::jsonb, updated_at = now()
     WHERE batch_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    [JSON.stringify(members), batchId],
  );
  if (!rows[0]) throw new Error(`extension_install_batches: no row for batch ${batchId}`);
  return rowToBatch(rows[0]);
}

export async function readInstallBatch(
  batchId: string,
  deps?: InstallBatchOpsDeps,
): Promise<InstallBatch | null> {
  const { query, schema } = await resolveDeps(deps);
  const rows = await query<BatchRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${qualifiedTable(schema)} WHERE batch_id = $1 LIMIT 1`,
    [batchId],
  );
  return rows[0] ? rowToBatch(rows[0]) : null;
}

/** All ACTIVE (planning/installing) batches — the overlap guard's read. */
export async function listActiveInstallBatches(
  deps?: InstallBatchOpsDeps,
): Promise<InstallBatch[]> {
  const { query, schema } = await resolveDeps(deps);
  const rows = await query<BatchRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${qualifiedTable(schema)}
      WHERE phase = ANY($1::text[])
      ORDER BY created_at ASC`,
    [[...ACTIVE_BATCH_PHASES]],
  );
  return rows.map(rowToBatch);
}

/**
 * Recent batches (any phase) for the extensions admin view — most-recently
 * updated first, capped. READ-ONLY surface over the existing ledger: it
 * supplies the per-member install progress + the batch compensation outcomes
 * the admin UX renders (cinatra #209 item 2). When `orgId` is provided only
 * that org's batches are returned (`null` = platform-scoped batches); omit it
 * to read across scopes (a platform_admin operator view).
 */
export async function listRecentInstallBatches(
  opts?: { limit?: number; orgId?: string | null },
  deps?: InstallBatchOpsDeps,
): Promise<InstallBatch[]> {
  const { query, schema } = await resolveDeps(deps);
  const limit = Math.min(Math.max(1, Math.trunc(opts?.limit ?? 25)), 200);
  const scopeProvided = opts !== undefined && "orgId" in opts;
  if (scopeProvided) {
    const rows = await query<BatchRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${qualifiedTable(schema)}
        WHERE org_id IS NOT DISTINCT FROM $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [opts!.orgId ?? null, limit],
    );
    return rows.map(rowToBatch);
  }
  const rows = await query<BatchRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${qualifiedTable(schema)}
      ORDER BY updated_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(rowToBatch);
}

/**
 * ACTIVE batches idle for ≥ `olderThanMs` — the boot sweeper's read (a batch
 * in-flight in another worker keeps advancing `updated_at` via member
 * patches, so a fresh threshold never sweeps a live batch).
 */
export async function listStaleInstallBatches(
  olderThanMs: number,
  deps?: InstallBatchOpsDeps,
): Promise<InstallBatch[]> {
  const { query, schema } = await resolveDeps(deps);
  const rows = await query<BatchRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${qualifiedTable(schema)}
      WHERE phase = ANY($1::text[])
        AND updated_at < (now() - ($2 || ' milliseconds')::interval)
      ORDER BY updated_at ASC`,
    [[...ACTIVE_BATCH_PHASES], String(Math.max(0, olderThanMs))],
  );
  return rows.map(rowToBatch);
}

/** Terminal (non-active) batch phases — a completed batch, one way or another. */
export const TERMINAL_BATCH_PHASES: readonly InstallBatchPhase[] = [
  "finalized",
  "failed",
  "compensated",
];

/**
 * TERMINAL batches still carrying a non-null side-by-side `grantCapsule` on any
 * member — the orphan-GC read (cinatra#1040 S6). A capsule is SPENT once its
 * batch is terminal: a finalized member's version committed (no teardown will
 * consume it); a compensated member was already reconciled. The happy path
 * RELEASES capsules at the finalize/compensate boundary; this read catches
 * capsules a crash left behind between the boundary and the release, so a boot
 * pass can clear them (with evidence). The `members::text LIKE` prefilter is a
 * cheap index-free narrowing (the JSONB is small); it matches only a NON-null
 * capsule OBJECT (`"grantCapsule":{`), never a released `"grantCapsule":null`.
 */
export async function listTerminalInstallBatchesWithCapsules(
  deps?: InstallBatchOpsDeps,
): Promise<InstallBatch[]> {
  const { query, schema } = await resolveDeps(deps);
  const rows = await query<BatchRow>(
    `SELECT ${SELECT_COLUMNS} FROM ${qualifiedTable(schema)}
      WHERE phase = ANY($1::text[])
        AND members::text LIKE '%"grantCapsule":{%'
      ORDER BY updated_at ASC`,
    [[...TERMINAL_BATCH_PHASES]],
  );
  return rows.map(rowToBatch);
}
