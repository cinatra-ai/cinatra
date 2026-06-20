import "server-only";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { agentRunPmLinks } from "./schema";

// ---------------------------------------------------------------------------
// pm-link-store CRUD (cinatra#317)
// ---------------------------------------------------------------------------
// Pure DB layer for the agent_run_pm_links table — the schedule↔PM-task sync
// link rows. One row per schedule-defining trigger (keyed by runId). The host
// PM bridge (src/lib/pm-integration-providers.ts) owns the provider resolution
// + Plane I/O and calls this store to PERSIST the mirror outcome:
//   - recordPmLinkSuccess: a push/upsert succeeded → store external_task_id +
//     synced_at, clear sync_error, bump version.
//   - recordPmLinkError: a fail-open push failed → store provider + sync_error
//     (external_task_id preserved if already set) so the reconcile loop (#318)
//     can retry; the trigger lifecycle is NOT blocked.
//   - readPmLinkByRunId / deletePmLinkByRunId: read + teardown.
// Server-only: never imported by client bundles.
// ---------------------------------------------------------------------------

export type PmLinkRecord = {
  runId: string;
  provider: string;
  externalTaskId: string | null;
  syncedAt: Date | null;
  syncError: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

function deserialize(row: typeof agentRunPmLinks.$inferSelect): PmLinkRecord {
  return {
    runId:          row.runId,
    provider:       row.provider,
    externalTaskId: row.externalTaskId,
    syncedAt:       row.syncedAt,
    syncError:      row.syncError,
    version:        row.version,
    createdAt:      row.createdAt,
    updatedAt:      row.updatedAt,
  };
}

export async function readPmLinkByRunId(
  runId: string,
): Promise<PmLinkRecord | null> {
  const [row] = await db
    .select()
    .from(agentRunPmLinks)
    .where(eq(agentRunPmLinks.runId, runId));
  return row ? deserialize(row) : null;
}

/**
 * Record a SUCCESSFUL mirror: upsert the link row with the provider's task id
 * and a fresh synced_at, clear any prior sync_error, and bump the version
 * counter (the reconcile loop's optimistic-concurrency signal). Idempotent
 * upsert keyed by runId.
 */
export async function recordPmLinkSuccess(input: {
  runId: string;
  provider: string;
  externalTaskId: string;
}): Promise<PmLinkRecord> {
  const now = new Date();
  const [row] = await db
    .insert(agentRunPmLinks)
    .values({
      runId:          input.runId,
      provider:       input.provider,
      externalTaskId: input.externalTaskId,
      syncedAt:       now,
      syncError:      null,
      version:        1,
      createdAt:      now,
      updatedAt:      now,
    })
    .onConflictDoUpdate({
      target: agentRunPmLinks.runId,
      set: {
        provider:       input.provider,
        externalTaskId: input.externalTaskId,
        syncedAt:       now,
        syncError:      null,
        version:        sql`${agentRunPmLinks.version} + 1`,
        updatedAt:      now,
      },
    })
    .returning();
  if (!row) {
    throw new Error(`recordPmLinkSuccess: no row returned for ${input.runId}`);
  }
  return deserialize(row);
}

/**
 * Record a FAILED (fail-open) mirror: upsert the link row carrying the provider
 * and the error text so the reconcile loop can retry. external_task_id is
 * preserved if a prior push already set one (the existing task may still live
 * upstream); synced_at is NOT advanced (the mirror is stale). Never throws on
 * the happy path — the trigger lifecycle treats PM as best-effort.
 */
export async function recordPmLinkError(input: {
  runId: string;
  provider: string;
  syncError: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(agentRunPmLinks)
    .values({
      runId:          input.runId,
      provider:       input.provider,
      externalTaskId: null,
      syncedAt:       null,
      syncError:      input.syncError,
      version:        0,
      createdAt:      now,
      updatedAt:      now,
    })
    .onConflictDoUpdate({
      target: agentRunPmLinks.runId,
      set: {
        provider:  input.provider,
        syncError: input.syncError,
        updatedAt: now,
        // external_task_id and synced_at intentionally preserved on conflict.
      },
    });
}

export async function deletePmLinkByRunId(runId: string): Promise<void> {
  await db.delete(agentRunPmLinks).where(eq(agentRunPmLinks.runId, runId));
}

/**
 * Keyset enumerator for the OUTBOUND-REPAIR reconcile loop (cinatra#318).
 *
 * Returns the bounded page of pm-link rows that need a repair attempt — rows
 * that are NOT in the healthy mirrored state. A healthy row is
 * `sync_error IS NULL AND external_task_id IS NOT NULL AND synced_at IS NOT
 * NULL`; this query is its complement:
 *
 *   sync_error IS NOT NULL   -- the last fail-open push errored (retry it)
 *   OR external_task_id IS NULL  -- never successfully pushed (no upstream id)
 *   OR synced_at IS NULL         -- never successfully mirrored
 *
 * (A row whose trigger CHANGED after a successful sync is already re-pushed by
 * the trigger lifecycle hook, so it carries no error and stays out of this set;
 * this loop is the REPAIR net for FAILED/DEFERRED pushes, not a trigger-diff.)
 *
 * Keyset-paginated on `run_id` ascending: pass the last `runId` of the prior
 * page as `afterRunId` (exclusive cursor) to fetch the next page. NEVER
 * full-scans into memory — callers page until a short page returns. `limit`
 * bounds the page size.
 */
export async function listPmLinksForReconcile(input: {
  afterRunId?: string;
  limit: number;
}): Promise<PmLinkRecord[]> {
  const needsAttention = or(
    sql`${agentRunPmLinks.syncError} IS NOT NULL`,
    isNull(agentRunPmLinks.externalTaskId),
    isNull(agentRunPmLinks.syncedAt),
  );
  const where =
    input.afterRunId !== undefined
      ? and(needsAttention, gt(agentRunPmLinks.runId, input.afterRunId))
      : needsAttention;

  const rows = await db
    .select()
    .from(agentRunPmLinks)
    .where(where)
    .orderBy(asc(agentRunPmLinks.runId))
    .limit(input.limit);

  return rows.map(deserialize);
}
