/**
 * PM schedule reconcile worker (cinatra#318).
 *
 * Sibling to `@cinatra-ai/marketplace-application-reconcile`'s
 * `runVendorApplicationStateReconcile`. Drives the OUTBOUND-REPAIR pass for the
 * schedule↔PM-task sync foundation (#317/#366): it sweeps the pm-link rows that
 * need attention (errored / never-synced / stale) and RE-PROJECTS the LOCAL
 * trigger state outward through the existing host PM bridge.
 *
 * WHY OUTBOUND-REPAIR, NOT INBOUND-APPLY (codex-converged Design B):
 *   The foundation deliberately built a ONE-DIRECTIONAL outbound mirror —
 *   "the local trigger is the source of truth; PM is a best-effort projection"
 *   (src/lib/pm-integration-providers.ts). The SDK `PmConnector` contract has
 *   ONLY `upsertTriggerTask` + `deleteTriggerTask` — there is NO read-back / get
 *   / list method, so there is no way to read PM state to "diff against". Plane
 *   also stores only a day-granularity calendar `target_date`, so a precise
 *   local cron CANNOT round-trip through Plane — applying a Plane date back to a
 *   local schedule would be data loss. So this loop REPAIRS failed/deferred
 *   OUTBOUND mirrors; it never applies inbound PM state to local schedules.
 *
 * THE SWEEP (every path is warn-and-skip-per-row, NEVER throws — a PM outage
 * must not poison the BullMQ queue or alter local schedules):
 *   1. ENUMERATE pm-link rows needing attention via `listLinksNeedingReconcile`
 *      (keyset on run_id, bounded page size — never a full in-memory scan).
 *   2. PER ROW, re-read the LOCAL trigger (`readLocalTrigger`) as the source of
 *      truth, then decide using ONLY the outbound contract:
 *        - local trigger EXISTS  -> RE-PUSH via `syncTrigger` (natural-key
 *          idempotent by runId; covers "existence" = re-create a dropped
 *          upstream task, and "paused/enabled" = re-project the enabled flag).
 *        - local trigger GONE + link has external_task_id -> finish the
 *          DEFERRED DELETE via `deleteTrigger`.
 *        - local trigger GONE + no external_task_id + NO sync_error (provably-
 *          clean never-attempted) -> route through `deleteTrigger`; the host
 *          bridge drops the dead link row (nothing was ever pushed upstream).
 *        - local trigger GONE + UNKNOWN upstream (external_task_id null BUT
 *          sync_error present) -> CANNOT prove-no-task with the outbound-only
 *          contract; leave the row STICKY + warn (dropping it could orphan a
 *          live task). A true prove-no-task needs a NEW SDK read/delete-by-
 *          natural-key method = a separate high-risk SDK follow-up, out of
 *          scope for #318.
 *   3. Re-read freshly per row; never upsert/delete from a stale scan snapshot.
 *      Count attempted/repaired/skipped/failed and log ONE summary line per
 *      sweep (silent when nothing to do), mirroring the vendor-reconcile worker.
 *
 * Composition (all injected by the cinatra-side deps factory
 * `buildPmScheduleReconcileDeps` so this package stays free of any
 * `@cinatra-ai/sdk-extensions` edge — the host bridge already owns provider
 * resolution):
 *   - `listLinksNeedingReconcile({ afterRunId, limit })` — keyset page of link
 *     rows that need a repair attempt.
 *   - `readLocalTrigger(runId)` — the LOCAL trigger row (source of truth) or null.
 *   - `syncTrigger(input)` — the host bridge `syncRunTriggerPmTask`.
 *   - `deleteTrigger({ runId })` — the host bridge `deleteRunTriggerPmTask`.
 */

/** A pm-link row, narrowed to the columns the reconcile decision needs. */
export interface PmLinkReconcileRow {
  runId: string;
  provider: string;
  externalTaskId: string | null;
  syncedAt: Date | null;
  syncError: string | null;
  version: number;
  updatedAt: Date;
}

/** The LOCAL trigger row, narrowed to what the outbound re-push needs. */
export interface LocalTriggerSnapshot {
  runId: string;
  triggerType: string;
  scheduledAt: Date | null;
  cronExpression: string | null;
  timezone: string;
  enabled: boolean;
  updatedAt: Date;
}

export interface PmScheduleReconcileDeps {
  /**
   * Keyset page of pm-link rows needing a repair attempt — rows with
   * `sync_error IS NOT NULL` OR `external_task_id IS NULL` OR a stale
   * `synced_at`. Ordered by run_id ascending; `afterRunId` is the exclusive
   * keyset cursor (undefined on the first page); `limit` bounds the page size.
   * NEVER full-scans into memory — the worker pages until a short page returns.
   */
  listLinksNeedingReconcile: (input: {
    afterRunId?: string;
    limit: number;
  }) => Promise<PmLinkReconcileRow[]>;
  /** Re-read the LOCAL trigger (the source of truth) for a run, or null. */
  readLocalTrigger: (runId: string) => Promise<LocalTriggerSnapshot | null>;
  /**
   * The host bridge `syncRunTriggerPmTask` — fail-open outbound upsert that
   * records its own success/error into the pm-link row. Idempotent by runId.
   */
  syncTrigger: (input: {
    runId: string;
    triggerType: string;
    scheduledAt?: string | null;
    cronExpression?: string | null;
    timezone: string;
    enabled: boolean;
  }) => Promise<void>;
  /**
   * The host bridge `deleteRunTriggerPmTask` — fail-open outbound delete that
   * keeps the row on unresolved provider / unknown upstream and drops it once
   * the provider delete succeeds (or there is provably nothing to clean up).
   */
  deleteTrigger: (input: { runId: string }) => Promise<void>;
}

export interface PmScheduleReconcileOptions {
  /**
   * Keyset page size for `listLinksNeedingReconcile`. The sweep pages through
   * the ENTIRE candidate set in bounded `pageSize` chunks (never slurps the
   * whole set into memory), so memory stays bounded regardless of backlog size.
   * Default 100.
   *
   * NOTE: there is deliberately NO per-sweep row cap. A cap that restarts from
   * the keyset head every tick would STARVE later rows whenever the first page
   * of candidates stays sticky/failing (they remain candidates and re-fill the
   * cap each tick). Paging to completion is both fair (every candidate is
   * reached each sweep) and bounded (each page is `pageSize`); the candidate
   * set is naturally small (only UNHEALTHY links), and per-row work is a single
   * fail-open bridge call. (codex-converged #318 fix.)
   */
  pageSize?: number;
}

export interface PmScheduleReconcileSummary {
  startedAt: string;
  finishedAt: string;
  /** Rows examined this sweep. */
  attempted: number;
  /** Rows where an outbound re-push or deferred delete was driven. */
  repaired: number;
  /** Rows intentionally left sticky (unknown upstream — cannot prove-no-task). */
  skipped: number;
  /** Rows where the repair attempt threw (counted, never rethrown). */
  failed: number;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * Run one OUTBOUND-REPAIR reconcile pass. Returns a per-run summary; never
 * throws (a PM outage / DB blip is logged + counted, the loop re-delays).
 *
 * The sweep pages through the ENTIRE candidate set in bounded `pageSize` chunks
 * — no per-sweep row cap (a head-restarting cap would starve later rows when
 * the first page stays sticky/failing). Memory stays bounded by `pageSize`.
 */
export async function runPmScheduleReconcile(
  deps: PmScheduleReconcileDeps,
  options: PmScheduleReconcileOptions = {},
): Promise<PmScheduleReconcileSummary> {
  const startedAt = new Date().toISOString();
  const pageSize = clampPositive(options.pageSize, DEFAULT_PAGE_SIZE);

  let attempted = 0;
  let repaired = 0;
  let skipped = 0;
  let failed = 0;

  let afterRunId: string | undefined = undefined;
  let exhausted = false;

  // Keyset pagination loop: pull bounded pages until a short page ends the
  // sweep. We never accumulate the full set, and we always advance the keyset
  // cursor PAST every row examined — including sticky/failed rows — so a row
  // that stays a candidate does not block later rows within or across sweeps.
  while (!exhausted) {
    let page: PmLinkReconcileRow[];
    try {
      page = await deps.listLinksNeedingReconcile({ afterRunId, limit: pageSize });
    } catch (err) {
      // Enumeration failed (DB blip) — abandon this sweep cleanly; the next
      // 10-minute tick re-reads from the start. NEVER throw.
      console.warn(
        "[pm-schedule-reconcile] listLinksNeedingReconcile threw — ending sweep early:",
        errText(err),
      );
      break;
    }

    if (page.length === 0) break;

    for (const row of page) {
      attempted++;
      // Advance the keyset cursor PAST this row before doing the work. Because
      // the cursor is `run_id > afterRunId` (strictly greater) and the row's
      // healthy/unhealthy state never moves its run_id, a row that REMAINS a
      // candidate (sticky / still-failing) is skipped past on the NEXT page
      // rather than re-fetched — so the sweep always makes forward progress to
      // the end of the candidate set and reaches every later row.
      afterRunId = row.runId;

      const outcome = await reconcileRow(deps, row);
      if (outcome === "repaired") repaired++;
      else if (outcome === "skipped") skipped++;
      else failed++;
    }

    // A short page (fewer than requested) means we reached the end of the
    // candidate set — stop paging.
    if (page.length < pageSize) exhausted = true;
  }

  // The per-run summary is returned for the BullMQ dispatcher to log a single
  // summary line (silent when nothing to do), mirroring the vendor-application
  // reconcile worker — the worker itself does not log the summary.
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    attempted,
    repaired,
    skipped,
    failed,
  };
}

type RowOutcome = "repaired" | "skipped" | "failed";

/**
 * Reconcile a SINGLE pm-link row. Re-reads the LOCAL trigger fresh (never trusts
 * the scan snapshot) and re-projects outward via the host bridge. Any throw is
 * caught + counted as `failed` so one bad row cannot stop the sweep.
 */
async function reconcileRow(
  deps: PmScheduleReconcileDeps,
  row: PmLinkReconcileRow,
): Promise<RowOutcome> {
  try {
    const trigger = await deps.readLocalTrigger(row.runId);

    if (trigger) {
      // The LOCAL schedule still exists (source of truth). Re-push it outward:
      // this naturally covers "existence" (re-create a dropped upstream task)
      // and "paused/enabled" (the enabled flag re-projected). The host bridge
      // is natural-key idempotent by runId and records its own success/error
      // into the link row, clearing sync_error + bumping version on success.
      await deps.syncTrigger({
        runId: trigger.runId,
        triggerType: trigger.triggerType,
        scheduledAt: trigger.scheduledAt ? trigger.scheduledAt.toISOString() : null,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        enabled: trigger.enabled,
      });
      return "repaired";
    }

    // The LOCAL trigger is GONE but a link row remains. (FK note: run_id ->
    // agent_runs CASCADE means "run gone, link remains" cannot occur; the real
    // case is "the trigger row was deleted but the run/link still exist" —
    // e.g. a delete that left the row sticky because the provider was down.)
    if (row.externalTaskId) {
      // We hold the cleanup pointer — finish the DEFERRED DELETE. The host
      // bridge unschedules the upstream task and drops the link row on success
      // (or keeps it for the next cycle on provider outage).
      await deps.deleteTrigger({ runId: row.runId });
      return "repaired";
    }

    // No external_task_id. Two sub-cases (codex-converged #318):
    if (!row.syncError) {
      // PROVABLY-CLEAN never-attempted row (no task id AND no error): nothing
      // was ever pushed, so there is no upstream task to orphan. Route through
      // the host bridge `deleteTrigger`, which drops a provably-clean row (its
      // `deleteRunTriggerPmTask` re-reads fresh and removes the row when there
      // is no task id and no error). Do NOT leave it sticky — that would leak
      // dead link rows forever once the trigger is gone.
      await deps.deleteTrigger({ runId: row.runId });
      return "repaired";
    }

    // UNKNOWN upstream: no external_task_id BUT a sync_error means a prior push
    // ERRORED/TIMED OUT and MAY have still created a Plane task the host never
    // observed. With the OUTBOUND-ONLY contract we cannot prove no task exists,
    // so we must NOT drop the row (that could orphan a live task). Leave it
    // STICKY + warn. A true prove-no-task needs a new SDK read/delete-by-
    // natural-key method = a separate high-risk SDK follow-up (out of scope).
    console.warn(
      `[pm-schedule-reconcile] run ${row.runId} has an unknown-upstream link ` +
        `(no external_task_id; last error: ${row.syncError}) and the local ` +
        `trigger is gone; leaving the row sticky (cannot prove-no-task with the ` +
        `outbound-only PM contract — see #318 follow-up).`,
    );
    return "skipped";
  } catch (err) {
    // Per-row failure: log + count, NEVER rethrow (one bad row must not stop
    // the sweep, and the loop must always re-delay).
    console.warn(
      `[pm-schedule-reconcile] reconciling run ${row.runId} failed (left for next cycle): ` +
        errText(err),
    );
    return "failed";
  }
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
