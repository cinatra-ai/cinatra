import "server-only";

/**
 * Production deps factory for `runPmScheduleReconcile` (cinatra#318). Wires the
 * PM schedule reconcile worker's injection points to live cinatra services,
 * keeping the worker package free of any `@cinatra-ai/sdk-extensions` edge — the
 * host PM bridge (`src/lib/pm-integration-providers.ts`) already owns provider
 * resolution + the fail-open outbound contract.
 *
 *   - `listLinksNeedingReconcile` → the keyset enumerator on the pm-link store
 *     (`@cinatra-ai/agents/pm-link-store`), returning the bounded page of rows
 *     that need a repair attempt (errored / never-synced).
 *   - `readLocalTrigger` → the LOCAL trigger reader
 *     (`@cinatra-ai/agents/trigger-store`), the source of truth re-projected
 *     outward.
 *   - `syncTrigger` / `deleteTrigger` → the existing host PM bridge
 *     (`syncRunTriggerPmTask` / `deleteRunTriggerPmTask`), which own provider
 *     resolution and record their own success/error into the link row.
 *
 * Unlike `buildVendorApplicationReconcileDeps`, this factory has NO external
 * credential prerequisite — provider resolution + fail-open are entirely inside
 * the host bridge, so the factory always returns a usable dep bundle. (When NO
 * PM provider is registered, the bridge's re-push is a clean no-op and the link
 * rows simply persist for a future cycle.)
 */

import {
  listPmLinksForReconcile,
  type PmLinkRecord,
} from "@cinatra-ai/agents/pm-link-store";
import { readRunTriggerByRunId } from "@cinatra-ai/agents/trigger-store";
import type {
  PmScheduleReconcileDeps,
  PmLinkReconcileRow,
  LocalTriggerSnapshot,
} from "@cinatra-ai/pm-schedule-reconcile";
import {
  syncRunTriggerPmTask,
  deleteRunTriggerPmTask,
} from "@/lib/pm-integration-providers";

function toReconcileRow(row: PmLinkRecord): PmLinkReconcileRow {
  return {
    runId: row.runId,
    provider: row.provider,
    externalTaskId: row.externalTaskId,
    syncedAt: row.syncedAt,
    syncError: row.syncError,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export function buildPmScheduleReconcileDeps(): PmScheduleReconcileDeps {
  return {
    listLinksNeedingReconcile: async ({ afterRunId, limit }) => {
      const rows = await listPmLinksForReconcile({ afterRunId, limit });
      return rows.map(toReconcileRow);
    },
    readLocalTrigger: async (runId): Promise<LocalTriggerSnapshot | null> => {
      const trigger = await readRunTriggerByRunId(runId);
      if (!trigger) return null;
      return {
        runId: trigger.runId,
        triggerType: trigger.triggerType,
        scheduledAt: trigger.scheduledAt,
        cronExpression: trigger.cronExpression,
        timezone: trigger.timezone,
        enabled: trigger.enabled,
        updatedAt: trigger.updatedAt,
      };
    },
    // The host bridge functions are fail-open by construction (they record
    // their own success/error into the pm-link row and never throw on the
    // outage path), so they slot straight into the worker's injection points.
    syncTrigger: (input) => syncRunTriggerPmTask(input),
    deleteTrigger: (input) => deleteRunTriggerPmTask(input),
  };
}
