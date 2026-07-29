import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  getPostgresConnectionString,
  postgresSchema,
  ensurePostgresSchema,
  readSkillCatalogFromDatabase,
  readAnthropicSkillSyncEnabledFromDatabase,
  readMetadataValueFromDatabase,
  writeMetadataValueToDatabase,
} from "@/lib/database";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import { createNotification } from "@/lib/notifications";
import {
  deriveApiKeyFingerprint,
  deriveEnvironmentNamespace,
  syncCatalogSkillsToAnthropicStrict,
} from "@/lib/anthropic-skill-sync-service";
import { reclaimStaleAnthropicSkills } from "@/lib/anthropic-skill-gc-service";

// ---------------------------------------------------------------------------
// Upload-on-install reconcile worker (cinatra#2092, epic #2086 S5).
//
// Drains the `anthropic_skill_reconcile_outbox` — the durable reconcile-request
// rows `replaceSkillCatalogInDatabase` (and the consent-ledger writers) commit
// in the SAME transaction as every catalog mutation — into WHOLE-CATALOG strict
// reconcile runs (`syncCatalogSkillsToAnthropicStrict`, the S0 strict
// orchestrator). Contract:
//
//   - The QUEUE is only the drain kick; these rows are the source of truth. A
//     crash between catalog commit and worker run loses no trigger — the row is
//     already committed, and the periodic reconcile loop (the safety net)
//     re-drains it.
//   - Runs are keyed `namespace (api-key fingerprint + environment) +
//     catalog-state digest`: a drain that claims only reconcile rows whose
//     catalog digest already completed for the namespace completes them without
//     engine work — duplicate drains are idempotent at the run level (and the
//     engine's content-hash comparisons make any residual re-run a remote
//     no-op).
//   - `kind='gc'` rows carry `not_before` at grace-window expiry (the uninstall
//     path's delayed GC); the periodic loop additionally runs the GC sweep each
//     cycle so revocation-staled rows reclaim after grace without manual steps.
//   - Failures retry with exponential backoff (`not_before`); rows exhausting
//     MAX_ATTEMPTS flip to `exhausted` (still visible, never silently dropped)
//     and notify the admin.
//   - Opt-in OFF / no API key: nothing egresses and the no-op is RECORDED on
//     the row (`outcome`), per the S5 acceptance criteria.
// ---------------------------------------------------------------------------

const LEASE_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const LAST_RUN_METADATA_KEY = "anthropic_skill_reconcile_last_run";
/** Upper bound on rows claimed per drain. The outbox insert is UNCONDITIONAL
 *  (a coalescing insert cannot be made sound — see buildInsertReconcileOutboxQuery),
 *  so a long outage or an install storm can leave a large backlog. Every row in
 *  it asks for the SAME whole-catalog reconcile, and the namespace+digest key
 *  collapses them into one engine run, so a bounded batch drains the backlog
 *  across a few cycles instead of leasing thousands of rows in one statement. */
const MAX_CLAIM_BATCH = 200;
/** Retention for COMPLETED rows. They are kept long enough to be useful for
 *  operator forensics after an incident, then pruned so an append-per-catalog-
 *  write table cannot grow without bound. `exhausted` rows are NEVER pruned —
 *  they are the visible record of a terminal failure. */
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type ClaimedRow = {
  id: string;
  kind: "reconcile" | "gc";
  reason: string;
  attempts: number;
};

export type ReconcileDrainSummary = {
  claimed: number;
  reconciled: number;
  skippedAlreadyReconciled: number;
  noop: number;
  gcCompleted: number;
  failed: number;
  exhausted: number;
};

function schemaIdent(): string {
  return postgresSchema.replaceAll('"', '""');
}

function run(queries: Array<{ text: string; values?: unknown[] }>, transaction = false) {
  ensurePostgresSchema();
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    ...(transaction ? { transaction: true } : {}),
    queries,
  });
}

/** Atomically claim up to MAX_CLAIM_BATCH DUE rows: pending-and-due, plus
 *  expired `running` leases from a crashed worker. `attempts` increments AT
 *  claim so a row that keeps crashing the worker still converges on
 *  `exhausted`. `FOR UPDATE SKIP LOCKED` in the selector keeps two concurrent
 *  drains from contending for the same rows. */
function claimDueRows(leaseToken: string): ClaimedRow[] {
  const s = schemaIdent();
  const [result] = run([
    {
      text: `WITH due AS (
          SELECT id FROM "${s}"."anthropic_skill_reconcile_outbox"
          WHERE (status = 'pending' AND (not_before IS NULL OR not_before <= now()))
             OR (status = 'running' AND lease_expires_at < now())
          ORDER BY created_at
          LIMIT $3
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "${s}"."anthropic_skill_reconcile_outbox" AS o
        SET status = 'running', lease_token = $1,
            lease_expires_at = now() + ($2::bigint * interval '1 millisecond'),
            attempts = attempts + 1
        FROM due
        WHERE o.id = due.id
        RETURNING o.id, o.kind, o.reason, o.attempts`,
      values: [leaseToken, LEASE_MS, MAX_CLAIM_BATCH],
    },
  ]);
  return (result?.rows ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      kind: String(row.kind) as ClaimedRow["kind"],
      reason: String(row.reason),
      attempts: Number(row.attempts),
    };
  });
}

/**
 * Prune COMPLETED outbox rows past the retention window. Runs on the periodic
 * sweep only (not on every kick), and never touches `exhausted` rows — those
 * are the durable, visible record of a terminal failure. Best-effort: a failed
 * prune must never fail a drain.
 */
function pruneCompletedRows(): void {
  const s = schemaIdent();
  try {
    run([
      {
        text: `DELETE FROM "${s}"."anthropic_skill_reconcile_outbox"
          WHERE status = 'done'
            AND completed_at IS NOT NULL
            AND completed_at < now() - ($1::bigint * interval '1 millisecond')`,
        values: [DONE_RETENTION_MS],
      },
    ]);
  } catch (err) {
    console.warn(
      "[anthropic-skill-reconcile] outbox retention prune failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

function completeRows(leaseToken: string, ids: string[], outcome: string): void {
  if (ids.length === 0) return;
  const s = schemaIdent();
  run([
    {
      text: `UPDATE "${s}"."anthropic_skill_reconcile_outbox"
        SET status = 'done', outcome = $2, completed_at = now(),
            lease_token = NULL, lease_expires_at = NULL
        WHERE lease_token = $1 AND id = ANY($3::text[])`,
      values: [leaseToken, outcome, ids],
    },
  ]);
}

/** Release failed rows back to `pending` with exponential backoff, or flip
 *  MAX-exhausted rows to `exhausted` (kept visible; admin notified by caller). */
function releaseFailedRows(leaseToken: string, rows: ClaimedRow[], error: string): {
  exhausted: ClaimedRow[];
} {
  if (rows.length === 0) return { exhausted: [] };
  const s = schemaIdent();
  const exhausted = rows.filter((r) => r.attempts >= MAX_ATTEMPTS);
  const retryable = rows.filter((r) => r.attempts < MAX_ATTEMPTS);
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  for (const r of retryable) {
    const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (r.attempts - 1), BACKOFF_CAP_MS);
    queries.push({
      text: `UPDATE "${s}"."anthropic_skill_reconcile_outbox"
        SET status = 'pending', lease_token = NULL, lease_expires_at = NULL,
            not_before = now() + ($2::bigint * interval '1 millisecond'), last_error = $3
        WHERE lease_token = $1 AND id = $4`,
      values: [leaseToken, backoff, error.slice(0, 2000), r.id],
    });
  }
  if (exhausted.length > 0) {
    queries.push({
      text: `UPDATE "${s}"."anthropic_skill_reconcile_outbox"
        SET status = 'exhausted', lease_token = NULL, lease_expires_at = NULL, last_error = $2
        WHERE lease_token = $1 AND id = ANY($3::text[])`,
      values: [leaseToken, error.slice(0, 2000), exhausted.map((r) => r.id)],
    });
  }
  if (queries.length > 0) run(queries, true);
  return { exhausted };
}

/** Deterministic digest of the persisted catalog state (payloads carry the
 *  projected `allowAnthropicUpload`, so consent changes always change it). */
function computeCatalogStateDigest(): string {
  const catalog = readSkillCatalogFromDatabase();
  const sortById = <T extends { id?: unknown }>(rows: T[]) =>
    [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return createHash("sha256")
    .update(
      JSON.stringify({
        skillPackages: sortById(catalog.skillPackages as Array<{ id?: unknown }>),
        skills: sortById(catalog.skills as Array<{ id?: unknown }>),
      }),
    )
    .digest("hex");
}

/**
 * The idempotency NAMESPACE key: the api-key fingerprint plus the environment.
 *
 * Deliberately a plain JOIN, not a re-hash. `deriveApiKeyFingerprint()` already
 * returns a stable opaque digest — it is the value stored in plaintext as
 * `anthropic_skill_sync.api_key_fingerprint`, so it is a public identifier by
 * construction, not a secret. Re-hashing it added nothing and read to static
 * analysis as hashing a credential with a fast, unsalted digest.
 */
function namespaceKey(fp: string, env: string): string {
  return `${fp}|${env}`;
}

type LastRunMap = Record<string, { digest: string; completedAt: string }>;

function readLastRunDigest(nsKey: string): string | null {
  const stored = readMetadataValueFromDatabase<LastRunMap | null>(LAST_RUN_METADATA_KEY, null);
  return stored?.[nsKey]?.digest ?? null;
}

function writeLastRunDigest(nsKey: string, digest: string): void {
  const stored = readMetadataValueFromDatabase<LastRunMap | null>(LAST_RUN_METADATA_KEY, null) ?? {};
  writeMetadataValueToDatabase(LAST_RUN_METADATA_KEY, {
    ...stored,
    [nsKey]: { digest, completedAt: new Date().toISOString() },
  });
}

async function notifyTerminalFailure(rows: ClaimedRow[], error: string): Promise<void> {
  try {
    await createNotification({
      title: `Anthropic skill upload reconcile gave up after ${MAX_ATTEMPTS} attempts`,
      body:
        `${rows.length} reconcile request(s) (${rows.map((r) => `${r.kind}:${r.reason}`).join("; ")}) ` +
        `exhausted their retries and were marked terminal. Skills may be missing from the ` +
        `Anthropic mirror until the next successful reconcile (a new install/save retriggers one). ` +
        `Last error: ${error.slice(0, 500)}`,
      kind: "error",
    });
  } catch (err) {
    console.warn(
      "[anthropic-skill-reconcile] terminal-failure notification failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Drain the reconcile outbox once. `gcSweep: true` (the periodic loop)
 * additionally runs the stale-GC reclaim even when no GC row is due, so
 * revocation-staled remote copies reclaim after the grace window without any
 * manual step. Safe to call concurrently — the claim UPDATE is atomic and the
 * engine run is serialized per namespace by the sync advisory lock.
 */
export async function runAnthropicSkillUploadReconcile(options?: {
  gcSweep?: boolean;
}): Promise<ReconcileDrainSummary> {
  const summary: ReconcileDrainSummary = {
    claimed: 0,
    reconciled: 0,
    skippedAlreadyReconciled: 0,
    noop: 0,
    gcCompleted: 0,
    failed: 0,
    exhausted: 0,
  };
  // Retention lives on the periodic sweep so the latency-sensitive one-shot
  // kick stays a pure claim→reconcile→complete path.
  if (options?.gcSweep === true) pruneCompletedRows();
  const leaseToken = randomUUID();
  const claimed = claimDueRows(leaseToken);
  summary.claimed = claimed.length;
  const reconcileRows = claimed.filter((r) => r.kind === "reconcile");
  const gcRows = claimed.filter((r) => r.kind === "gc");
  const wantGc = options?.gcSweep === true || gcRows.length > 0;
  if (claimed.length === 0 && !wantGc) return summary;

  // Governance first: opt-in OFF ⇒ zero egress, zero engine work — the no-op
  // is RECORDED on every claimed row (S5 AC). The projection/gate stay
  // authoritative on the use path regardless.
  let optIn = false;
  try {
    optIn = readAnthropicSkillSyncEnabledFromDatabase() === true;
  } catch {
    optIn = false;
  }
  if (!optIn) {
    completeRows(leaseToken, claimed.map((r) => r.id), "noop-opt-in-off");
    summary.noop = claimed.length;
    return summary;
  }
  const fp = deriveApiKeyFingerprint();
  if (!fp) {
    completeRows(leaseToken, claimed.map((r) => r.id), "noop-no-api-key");
    summary.noop = claimed.length;
    return summary;
  }

  try {
    let env: string;
    try {
      env = deriveEnvironmentNamespace();
    } catch (err) {
      // Fail-closed config error — retryable (an operator fixing SUPABASE_DB_URL
      // heals it); rows back off and exhaust into a visible notification.
      throw err instanceof Error ? err : new Error(String(err));
    }
    const nsKey = namespaceKey(fp, env);

    if (reconcileRows.length > 0) {
      // Idempotency key = namespace + catalog-state digest: a duplicate drain
      // of an already-reconciled catalog completes without engine work.
      const digest = computeCatalogStateDigest();
      if (readLastRunDigest(nsKey) === digest) {
        completeRows(
          leaseToken,
          reconcileRows.map((r) => r.id),
          `already-reconciled digest=${digest.slice(0, 16)}`,
        );
        summary.skippedAlreadyReconciled = reconcileRows.length;
      } else {
        const result = await syncCatalogSkillsToAnthropicStrict();
        writeLastRunDigest(nsKey, digest);
        const refused = result.captureDiagnostics?.refusedForDanglingReferences ?? [];
        const ineligible = result.outcomes.filter(
          (o) => o.action === "skipped" && o.reason === "governance_denied",
        );
        completeRows(
          leaseToken,
          reconcileRows.map((r) => r.id),
          `reconciled digest=${digest.slice(0, 16)} outcomes=${result.outcomes.length} ` +
            `upload-ineligible=${ineligible.length} refused=${refused.length}`,
        );
        summary.reconciled = reconcileRows.length;
      }
    }

    if (wantGc) {
      const gc = await reclaimStaleAnthropicSkills();
      if (!gc.ok) {
        const detail =
          gc.namespaceError ??
          (gc.errors.length > 0
            ? gc.errors.map((e) => `${e.anthropicSkillId}: ${e.message}`).join("; ")
            : "Anthropic skill GC reported an error.");
        throw new Error(`GC failed: ${detail}`);
      }
      completeRows(
        leaseToken,
        gcRows.map((r) => r.id),
        `gc reclaimed=${gc.reclaimed.length} skipped=${gc.skipped.length}`,
      );
      summary.gcCompleted = gcRows.length;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Release every row this run still leases (completed rows no longer match
    // the lease token, so a partial success is preserved).
    const stillLeased = claimed.filter((r) =>
      summary.reconciled > 0 || summary.skippedAlreadyReconciled > 0
        ? r.kind === "gc"
        : true,
    );
    const { exhausted } = releaseFailedRows(leaseToken, stillLeased, message);
    summary.failed = stillLeased.length - exhausted.length;
    summary.exhausted = exhausted.length;
    if (exhausted.length > 0) await notifyTerminalFailure(exhausted, message);
    console.warn(
      "[anthropic-skill-reconcile] drain failed (retry with backoff): %s",
      message,
    );
  }
  return summary;
}
