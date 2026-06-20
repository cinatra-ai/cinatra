import "server-only";

// Host-side resolution of the PM (project-management) integration capability
// provider for the schedule↔PM-task sync (cinatra#317). Mirrors
// src/lib/crm-integration-providers.ts: packages/agents NEVER imports the SDK
// PM registry or any Plane code — it calls OUT to these two narrow, fail-open
// functions via the Next.js "@/lib/*" alias (Option 2 / the host-owned PM
// provider bridge; codex-converged GO). The host names no connector package.
//
//   - syncRunTriggerPmTask({ runId, … }): resolve the registered PM provider
//     and push/upsert the Plane work item mirroring the schedule-DEFINING
//     trigger; persist the returned external task id into the pm-link table.
//   - deleteRunTriggerPmTask({ runId }): resolve the provider and
//     unschedule/delete the Plane work item; tear down the pm-link row.
//
// OUTAGE POLICY (issue #317 / spike #314): the trigger lifecycle is the source
// of truth for the LOCAL schedule. A PM provider that is absent / inactive /
// unreachable must NEVER throw out of these functions and NEVER block or
// disable the local schedule — every path is fail-open + log. A failed push is
// recorded in the pm-link row (sync_error) so the reconcile loop (#318) retries.

import { PM_PROVIDER_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import {
  lookupPmProvider,
  listPmProviders,
  type PmConnector,
} from "@cinatra-ai/sdk-extensions";
import {
  readPmLinkByRunId,
  recordPmLinkSuccess,
  recordPmLinkError,
  deletePmLinkByRunId,
} from "@cinatra-ai/agents/pm-link-store";

// Re-exported only so the capability id has a single import site here; the
// resolver binding lives in register-pm-providers.ts.
export { PM_PROVIDER_CAPABILITY };

// Bounded ceiling for a single PM provider call (codex#317 caveat): the trigger
// lifecycle AWAITS the mirror, so a provider whose HTTP call never settles would
// otherwise hold the (already-persisted) schedule operation open indefinitely.
// A non-settling provider is treated as a fail-open outage at this ceiling. The
// connector owns its own per-request timeouts; this is the host's backstop.
const PM_CALL_TIMEOUT_MS = 10_000;

/** Race a provider call against a bounded ceiling; reject (fail-open) on timeout. */
function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${PM_CALL_TIMEOUT_MS}ms`));
    }, PM_CALL_TIMEOUT_MS);
    // Do not keep the event loop alive solely for this timer.
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * The live PM provider to address, or null when none can be safely resolved.
 *
 * Two strict cases — NEVER guess a provider (codex#317: an arbitrary `all[0]`
 * could send a Plane task id to the WRONG provider once a second PM connector
 * exists):
 *   - A `preferredId` (the id a link row already named): resolve THAT exact id,
 *     or null if it is no longer registered. Do NOT fall back to a different
 *     provider — the external task id belongs to the named provider.
 *   - No `preferredId` (first push): auto-select ONLY when exactly one provider
 *     is registered (the single-PM-provider deployment, plane today). With zero
 *     or more-than-one registered, return null (ambiguous — refuse to guess).
 */
function resolvePmProvider(preferredId?: string | null): PmConnector | null {
  if (preferredId) {
    // The link row pins the owning provider — resolve that id ONLY.
    return lookupPmProvider(preferredId);
  }
  const all = listPmProviders();
  return all.length === 1 ? all[0] : null;
}

export type SyncRunTriggerPmTaskInput = {
  runId: string;
  triggerType: string;
  scheduledAt?: string | null;
  cronExpression?: string | null;
  timezone: string;
  enabled: boolean;
};

/**
 * Push/upsert the Plane work item mirroring a schedule-defining trigger.
 * Fail-open: any provider outage / error is logged and recorded in the pm-link
 * row, never thrown — the caller's local schedule is already persisted.
 */
export async function syncRunTriggerPmTask(
  input: SyncRunTriggerPmTaskInput,
): Promise<void> {
  let existing: Awaited<ReturnType<typeof readPmLinkByRunId>> = null;
  try {
    existing = await readPmLinkByRunId(input.runId);
  } catch (err) {
    // A link-read FAILURE (vs a clean "no row") leaves the prior mirror state
    // UNKNOWN — we cannot tell whether a link to some provider A already exists.
    // Proceeding as a first push could (a) address a DIFFERENT provider B and
    // (b) overwrite the A pointer via recordPmLinkSuccess (natural-key
    // idempotency only protects SAME-provider retries). So SKIP the PM sync
    // entirely (codex#317): the local schedule is already durable, and the
    // reconcile loop (#318) repairs the missed mirror. NEVER throw.
    console.warn(
      `[pm-sync] reading pm-link for run ${input.runId} failed; skipping PM mirror this cycle (schedule unaffected; reconcile will repair): ` +
        errText(err),
    );
    return;
  }

  const provider = resolvePmProvider(existing?.provider ?? null);
  if (!provider) {
    // No PM provider registered — the schedule runs locally without a mirror.
    // Not an error (the connector is acquirable-on-demand, not required).
    return;
  }

  // existingTaskId is the prior id, or null on a first push OR after a lost
  // (timed-out/errored) first push that left an unknown-upstream row. Passing
  // null on the unknown-state re-sync is SAFE because the PmConnector contract
  // REQUIRES natural-key idempotency by task.runId (find-or-create by runId) —
  // so a slow first push that actually created the item is RE-FOUND here and
  // updated, re-establishing the link, instead of orphaning a duplicate
  // (codex#317; see PmConnector.upsertTriggerTask).
  try {
    const ref = await withTimeout(
      provider.upsertTriggerTask({
        task: {
          runId: input.runId,
          triggerType: input.triggerType,
          scheduledAt: input.scheduledAt ?? null,
          cronExpression: input.cronExpression ?? null,
          timezone: input.timezone,
          enabled: input.enabled,
        },
        existingTaskId: existing?.externalTaskId ?? null,
      }),
      `[pm-sync] upsert for run ${input.runId}`,
    );
    await recordPmLinkSuccess({
      runId: input.runId,
      provider: ref.providerId || provider.providerId,
      externalTaskId: ref.externalTaskId,
    });
  } catch (err) {
    // PM outage / push error: log + record, NEVER throw (fail-open).
    console.warn(
      `[pm-sync] mirroring run ${input.runId} to provider "${provider.providerId}" failed (schedule unaffected): ` +
        errText(err),
    );
    try {
      await recordPmLinkError({
        runId: input.runId,
        provider: provider.providerId,
        syncError: errText(err),
      });
    } catch (recordErr) {
      console.warn(
        `[pm-sync] recording pm-link error for run ${input.runId} also failed: ` +
          errText(recordErr),
      );
    }
  }
}

/**
 * Unschedule/delete the Plane work item for a run and tear down the pm-link
 * row. Fail-open: the local trigger is already gone, so this NEVER throws and
 * NEVER blocks the trigger teardown. The link row is dropped ONLY when there is
 * no residual external task to clean up, or the provider delete actually
 * succeeded — a residual external task with no resolvable / failing provider
 * KEEPS the row so the reconcile loop (#318) still holds the cleanup pointer
 * (codex#317: dropping the row would lose the only reference to the live task).
 */
export async function deleteRunTriggerPmTask(input: {
  runId: string;
}): Promise<void> {
  let existing: Awaited<ReturnType<typeof readPmLinkByRunId>> = null;
  try {
    existing = await readPmLinkByRunId(input.runId);
  } catch (err) {
    console.warn(
      `[pm-sync] reading pm-link for run ${input.runId} (delete) failed (continuing): ` +
        errText(err),
    );
  }

  // Nothing was ever mirrored — nothing to delete.
  if (!existing) return;

  if (!existing.externalTaskId) {
    // No recorded external task id. Two sub-cases (codex#317): a row only ever
    // reaches null-task state via recordPmLinkError, so it ALWAYS carries a
    // sync_error. A prior push that ERRORED OR TIMED OUT may have STILL created
    // a Plane task the host never observed (withTimeout rejects the host await
    // without cancelling the in-flight provider call). That is UNKNOWN upstream
    // state — dropping the row would orphan a possibly-live task. KEEP it for
    // the reconcile loop (#318), which can query the provider to PROVE no task
    // exists before removing the row. Only a provably-clean row (no task AND no
    // error — never attempted) is safe to drop here.
    if (existing.syncError) {
      console.warn(
        `[pm-sync] run ${input.runId} has an unresolved PM push (no task id, last error: ${existing.syncError}); leaving pm-link for reconcile to prove no task exists.`,
      );
      return;
    }
    await dropPmLinkRow(input.runId);
    return;
  }

  const provider = resolvePmProvider(existing.provider);
  if (!provider) {
    // The owning provider is no longer registered, but a live external task may
    // still exist — KEEP the row so the reconcile loop retries the unschedule
    // once the provider returns. Do not orphan the cleanup pointer.
    console.warn(
      `[pm-sync] no PM provider "${existing.provider}" registered to delete task ${existing.externalTaskId} for run ${input.runId}; leaving pm-link for reconcile.`,
    );
    return;
  }

  try {
    await withTimeout(
      provider.deleteTriggerTask({
        runId: input.runId,
        externalTaskId: existing.externalTaskId,
      }),
      `[pm-sync] delete for run ${input.runId}`,
    );
  } catch (err) {
    // Provider outage: leave the link row so the reconcile loop retries the
    // unschedule; do NOT throw and do NOT block the local trigger teardown.
    console.warn(
      `[pm-sync] deleting Plane task for run ${input.runId} (provider "${provider.providerId}") failed; leaving pm-link for reconcile: ` +
        errText(err),
    );
    return;
  }

  // Provider delete succeeded — drop the link row.
  await dropPmLinkRow(input.runId);
}

async function dropPmLinkRow(runId: string): Promise<void> {
  try {
    await deletePmLinkByRunId(runId);
  } catch (err) {
    console.warn(
      `[pm-sync] removing pm-link row for run ${runId} failed: ` +
        errText(err),
    );
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
