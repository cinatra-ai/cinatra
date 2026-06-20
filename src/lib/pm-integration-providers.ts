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
  type PmTaskState,
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

// SEPARATE, tighter ceiling for the PRE-EXECUTION read (cinatra#319). This call
// is on the trigger fire path (the run is about to execute), so it must not hold
// the worker for the full 10s write ceiling — a slow PM read fails open FAST and
// the schedule proceeds. Distinct from PM_CALL_TIMEOUT_MS (the write ceiling).
const PM_PREEXEC_READ_TIMEOUT_MS = 3_000;

/** Race a provider call against a bounded ceiling; reject (fail-open) on timeout. */
function withTimeout<T>(
  p: Promise<T>,
  label: string,
  timeoutMs: number = PM_CALL_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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

// ---------------------------------------------------------------------------
// readRunTriggerPmState — the PRE-EXECUTION PM check (cinatra#319)
// ---------------------------------------------------------------------------
// Called from runAgentRunTriggerReleaseJob at fire time, BEFORE the release
// logic, so a PM-side delete / reschedule / pause is honored before the run
// fires. Resolves the link row + the named provider, reads the PM-side state,
// and diffs it against the LOCAL trigger snapshot the caller passes in.
//
// Returns a DISCRIMINATED result the caller switches on (NEVER throws — this is
// the execution hot path; any throw/timeout/outage maps to `unreachable`):
//   - no-provider : no pm-link row at all (the schedule was never mirrored) →
//                   fail-open proceed (run fires normally).
//   - no-link     : a pm-link row exists but has no external task id yet (a push
//                   that never resolved an id) → fail-open proceed; reconcile
//                   (#318) repairs the link.
//   - unreachable : the named provider is not registered (misconfigured), or the
//                   read threw / timed out → fail-open proceed (+ warn).
//   - deleted     : the provider returned null (the upstream task is GONE) →
//                   caller tears the local schedule down.
//   - paused      : the PM surface has the task paused → caller skips THIS fire
//                   only, leaving the schedule intact.
//   - rescheduled : the PM cron and/or instant differs from the local trigger →
//                   caller refreshes the schedule to the PM values.
//   - present     : the task exists, is not paused, and matches local → fail-open
//                   proceed (run fires normally).
// ---------------------------------------------------------------------------

export type PmPreExecState =
  | { kind: "no-provider" }
  | { kind: "no-link" }
  | { kind: "unreachable"; reason: string }
  | { kind: "deleted" }
  | { kind: "paused" }
  | { kind: "rescheduled"; cronExpression: string | null; scheduledAt: string | null }
  | { kind: "present" };

export type ReadRunTriggerPmStateInput = {
  runId: string;
  /**
   * The local trigger type. The reschedule diff is type-scoped (codex#319):
   *   - "recurring" → diff ONLY the cron. A provider may ALSO return a derived
   *     next-fire `scheduledAt` for a recurring task; comparing it against the
   *     local recurring row (whose scheduledAt is always null) would flag a
   *     phantom reschedule EVERY tick → refresh-skip forever, never firing.
   *   - "scheduled" → diff ONLY the instant (cron is always null for one-shots).
   * When omitted, both fields are diffed (legacy/test convenience).
   */
  triggerType?: "scheduled" | "recurring" | "immediate";
  /** The local trigger's cron (recurring) or null — diffed against PM state. */
  localCronExpression?: string | null;
  /** The local trigger's exact instant as ISO-8601 (scheduled) or null. */
  localScheduledAt?: string | null;
};

/**
 * Read the PM-side state for a run's mirrored task and classify it against the
 * local trigger snapshot. NEVER throws: every error/outage path returns an
 * `unreachable`/`no-*` result so the caller can fail open and fire the run.
 */
export async function readRunTriggerPmState(
  input: ReadRunTriggerPmStateInput,
): Promise<PmPreExecState> {
  // 1. Resolve the link row. A read FAILURE (vs a clean "no row") leaves the
  //    mirror state unknown — fail open rather than risk a false delete/pause.
  let existing: Awaited<ReturnType<typeof readPmLinkByRunId>> = null;
  try {
    existing = await readPmLinkByRunId(input.runId);
  } catch (err) {
    return { kind: "unreachable", reason: `pm-link read failed: ${errText(err)}` };
  }

  // No row at all → the schedule was never mirrored to any PM provider.
  if (!existing) return { kind: "no-provider" };

  // A row exists but carries no external task id (a push that never resolved an
  // id, or an errored/timed-out first push). There is nothing to read upstream
  // by id — fail open; the reconcile loop (#318) repairs the link.
  if (!existing.externalTaskId) return { kind: "no-link" };

  // 2. Resolve the OWNING provider by the id the link row pins. An existing link
  //    whose named provider is NOT registered is MISCONFIGURED (the provider
  //    extension was removed/disabled) — that is `unreachable`, NOT `no-provider`
  //    (codex#319: never silently fire-and-forget a real mirrored task).
  const provider = resolvePmProvider(existing.provider);
  if (!provider) {
    return {
      kind: "unreachable",
      reason: `pm provider "${existing.provider}" for task ${existing.externalTaskId} is not registered`,
    };
  }

  // 3. Read PM state under the TIGHT pre-exec ceiling. Any throw/timeout → fail
  //    open as `unreachable`. ONLY a clean `null` means the task was deleted.
  let state: PmTaskState | null;
  try {
    state = await withTimeout(
      provider.readTriggerTask({
        runId: input.runId,
        externalTaskId: existing.externalTaskId,
      }),
      `[pm-preexec] read for run ${input.runId}`,
      PM_PREEXEC_READ_TIMEOUT_MS,
    );
  } catch (err) {
    return {
      kind: "unreachable",
      reason: `pm read for run ${input.runId} failed: ${errText(err)}`,
    };
  }

  // Definitive upstream delete: ONLY a clean `null` (NOT undefined, NOT a
  // malformed object) means the task was deleted. Distinguish them explicitly.
  if (state === null) return { kind: "deleted" };

  // Defense in depth (codex#319): the structural provider guard only validates
  // that `readTriggerTask` is a function, NOT the SHAPE it resolves. A
  // misbehaving extension that resolves `undefined` or a malformed object would
  // make `state.paused` / the field reads below throw OUT of this "never throws"
  // bridge and into the fire path. Treat any non-conforming state as a fail-open
  // `unreachable` (proceed to fire) — never as delete/pause/reschedule.
  if (!isPmTaskState(state)) {
    return {
      kind: "unreachable",
      reason: `pm read for run ${input.runId} returned a malformed task state`,
    };
  }

  // Paused wins over a reschedule diff: a paused task should not fire OR refresh
  // this tick — skip and re-check next tick (codex#319: PM-authoritative).
  if (state.paused) return { kind: "paused" };

  // 4. Diff the PM schedule against the local snapshot, SCOPED to the trigger
  //    type so a recurring task's provider-derived next-fire `scheduledAt` does
  //    not flag a phantom reschedule every tick (codex#319). Recurring diffs the
  //    cron only; scheduled diffs the instant only; an unknown/omitted type
  //    diffs both (conservative). Normalize undefined → null for a stable compare.
  const localCron = input.localCronExpression ?? null;
  const localAt = input.localScheduledAt ?? null;
  const pmCron = state.cronExpression ?? null;
  const pmAt = state.scheduledAt ?? null;
  const cronChanged = pmCron !== localCron;
  const atChanged = pmAt !== localAt;
  const changed =
    input.triggerType === "recurring"
      ? cronChanged
      : input.triggerType === "scheduled"
        ? atChanged
        : cronChanged || atChanged;
  if (changed) {
    return { kind: "rescheduled", cronExpression: pmCron, scheduledAt: pmAt };
  }

  // Task exists, not paused, matches local → fire normally.
  return { kind: "present" };
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

/**
 * Structural guard for a provider-returned PmTaskState. A conforming state has a
 * non-empty string externalTaskId, a boolean paused, and string-or-null cron /
 * scheduledAt. Anything else (undefined, wrong types, missing fields) is treated
 * by the caller as a fail-open `unreachable`, never as a definitive PM signal.
 */
function isPmTaskState(v: unknown): v is PmTaskState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as {
    externalTaskId?: unknown;
    paused?: unknown;
    cronExpression?: unknown;
    scheduledAt?: unknown;
  };
  return (
    typeof s.externalTaskId === "string" &&
    s.externalTaskId.length > 0 &&
    typeof s.paused === "boolean" &&
    (s.cronExpression === null || typeof s.cronExpression === "string") &&
    (s.scheduledAt === null || typeof s.scheduledAt === "string")
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
