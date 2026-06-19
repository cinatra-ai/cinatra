import "server-only";

// Host-side resolution of the PM (project-management) integration capability
// provider (the lazy/guarded host-access cutover, mirroring
// src/lib/crm-integration-providers.ts): the trigger lifecycle (in
// packages/agents) no longer dynamic-imports a PM connector — it calls these
// thin host indirections, which resolve the registered `pm-provider` at call
// time through the SDK PM provider registry's external resolver
// (src/lib/register-pm-providers.ts).
//
// FAIL-OPEN by contract: a PM outage (connector absent/inactive, provider
// throws, upstream down) must NEVER break trigger configuration or deletion.
// Every function here resolves the provider, delegates, and on ANY failure
// logs + returns — the trigger op continues. The PmConnector verb methods are
// fail-LOUD (they throw); this module is the ONE place that converts that into
// fail-open behavior for the trigger lifecycle.

import { lookupPmProvider, type PmConnector } from "@cinatra-ai/sdk-extensions";

// The provider id the host mirrors triggers into. A single PM provider is
// resolved per deployment (the registered connector); a multi-provider future
// would thread an explicit id here. `plane` is the only PM provider today.
const PM_PROVIDER_ID = "plane";

/** Resolve the registered PM provider, or null when none is registered
 *  (connector absent/inactive). Never throws. */
function resolvePmProvider(): PmConnector | null {
  try {
    return lookupPmProvider(PM_PROVIDER_ID);
  } catch (err) {
    console.warn(
      `[pm-integration] provider resolution failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export type SyncRunTriggerPmTaskInput = {
  runId: string;
  triggerType: string;
  scheduledAt?: string | null;
  cronExpression?: string | null;
  timezone?: string | null;
  enabled?: boolean;
  title?: string | null;
};

/**
 * Push/upsert the Plane work item mirroring a run trigger. Fail-open: resolves
 * the registered PM provider and upserts; on no-provider or any error, logs and
 * returns without throwing (the trigger lifecycle is unaffected).
 */
export async function syncRunTriggerPmTask(
  input: SyncRunTriggerPmTaskInput,
): Promise<void> {
  const provider = resolvePmProvider();
  if (!provider) return; // degraded: no PM connector registered — nothing to mirror.
  try {
    await provider.upsertRunTask({
      runId: input.runId,
      triggerType: input.triggerType,
      scheduledAt: input.scheduledAt ?? null,
      cronExpression: input.cronExpression ?? null,
      timezone: input.timezone ?? null,
      enabled: input.enabled ?? true,
      title: input.title ?? null,
    });
  } catch (err) {
    console.warn(
      `[pm-integration] syncRunTriggerPmTask failed for run ${input.runId} ` +
        `(continuing — PM mirror is best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Delete/unschedule the Plane work item mirroring `runId`. Fail-open: resolves
 * the registered PM provider and deletes; on no-provider or any error, logs and
 * returns without throwing.
 */
export async function deleteRunTriggerPmTask(input: { runId: string }): Promise<void> {
  const provider = resolvePmProvider();
  if (!provider) return;
  try {
    await provider.deleteRunTask({ runId: input.runId });
  } catch (err) {
    console.warn(
      `[pm-integration] deleteRunTriggerPmTask failed for run ${input.runId} ` +
        `(continuing — PM mirror is best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read the mirrored PM task for `runId`, or null when no provider is registered
 * or the read fails (fail-open — the pre-execution PM-state check warns and
 * skips rather than blocking the run).
 */
export async function getRunTriggerPmTask(input: {
  runId: string;
}): Promise<{ id: string; state: string | null } | null> {
  const provider = resolvePmProvider();
  if (!provider) return null;
  try {
    const task = await provider.getRunTask({ runId: input.runId });
    if (!task) return null;
    return { id: task.id, state: task.state ?? null };
  } catch (err) {
    console.warn(
      `[pm-integration] getRunTriggerPmTask failed for run ${input.runId} ` +
        `(continuing — PM mirror is best-effort): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
