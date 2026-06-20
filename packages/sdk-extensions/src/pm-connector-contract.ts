// Provider-agnostic PM (project-management) CONTRACT (types only) — lives in
// the SDK so PM provider extensions (plane-connector today; linear/jira later)
// and the host PM bridge share the contract WITHOUT importing each other by
// name.
//
// Every PM provider package implements `PmConnector`. The host bridge
// (src/lib/pm-integration-providers.ts) resolves the registered provider and
// delegates the schedule→task mirror to it. Provider packages import these
// symbols via `import type { ... }` only — the contract has no runtime code.
//
// Mirrors the CRM contract's role (crm-connector-contract.ts): the SCHEDULE
// side of #313/#317 is "mirror a cinatra agent-run trigger to a PM work item",
// the dual of the CRM side's "mirror a cinatra object to a CRM record".

export type PmConnectorId = string;

/**
 * cinatra-shaped trigger snapshot the host pushes to the PM provider. The
 * provider maps this to its own work-item shape (Plane: a work item under
 * /workspaces/{slug}/projects/{project_id}/work-items/ with start_date /
 * target_date — NEVER due_date, which Plane REST silently drops).
 *
 * Only the schedule-DEFINING trigger is mirrored, never the recurring child
 * runs it spawns — so the natural key is the top-level `runId`.
 */
export type PmTriggerTask = {
  /** Top-level agent_run id — the stable natural key for the mirrored task. */
  runId: string;
  /** 'immediate' | 'scheduled' | 'recurring' (the cinatra trigger type). */
  triggerType: string;
  /** The next/exact fire instant as an ISO-8601 string, or null. cinatra stays
   *  authoritative for the exact instant; the provider reconciles at day
   *  granularity (Plane target_date is a calendar date). */
  scheduledAt?: string | null;
  /** The cron expression for recurring triggers, or null. */
  cronExpression?: string | null;
  /** IANA timezone the schedule is interpreted in. */
  timezone: string;
  /** Whether the schedule is currently armed. A disabled schedule still
   *  mirrors a task (so the PM surface shows it paused), per the outage
   *  policy: PM state never silently disables the local schedule. */
  enabled: boolean;
};

/**
 * The provider's record of a mirrored task — the host persists `externalTaskId`
 * in the pm-link table so a later update/delete addresses the same work item.
 */
export type PmTaskRef = {
  /** The provider's stable work-item id (Plane work_item.id). */
  externalTaskId: string;
  /** The provider id that owns this task (e.g. "plane"). */
  providerId: PmConnectorId;
};

/**
 * The PM-side state of a mirrored task, READ back at execution time so the host
 * can honor a PM-side delete / reschedule / pause before firing the schedule
 * (cinatra#319 pre-execution PM check; cinatra#318 reconcile loop).
 *
 * This is the inbound dual of `PmTriggerTask` (the outbound mirror): it carries
 * ONLY the fields the host diffs against the local trigger row to decide
 * delete / refresh / pause / proceed. The provider maps its own work-item shape
 * BACK to these provider-agnostic fields (Plane: `is_paused`/state, the cron
 * stamped on the item, and `target_date`/`start_date` → `scheduledAt`).
 *
 * A `null` return from `readTriggerTask` (NOT a `PmTaskState` with empty fields)
 * is the explicit "the upstream task was DELETED" signal — the host tears the
 * local schedule down. Any provider outage/timeout must NOT surface as `null`
 * (that would falsely delete a live schedule on a blip); the host treats a
 * thrown/timed-out read as "unreachable → fail-open proceed", never as delete.
 */
export type PmTaskState = {
  /** The provider's stable work-item id this state belongs to. */
  externalTaskId: string;
  /** Whether the PM surface currently has the task paused. */
  paused: boolean;
  /** The cron expression the PM side currently holds, or null (one-shot / none). */
  cronExpression: string | null;
  /** The exact next/target fire instant as an ISO-8601 string, or null. */
  scheduledAt: string | null;
};

/**
 * Provider-agnostic PM connector surface. A PM provider extension registers an
 * impl behind the `pm-provider` capability from its own `register(ctx)`; the
 * host resolves it lazily through the SDK registry's external resolver.
 */
export interface PmConnector {
  /** Stable provider id, e.g. "plane". */
  providerId: string;

  /**
   * Idempotent upsert of the work item mirroring a schedule-defining trigger.
   * `existingTaskId` is the previously-persisted external id, or null on the
   * first push. The provider updates the item when `existingTaskId` is present
   * (and re-creates if it was deleted upstream).
   *
   * NATURAL-KEY IDEMPOTENCY (REQUIRED — load-bearing, codex#317): the natural
   * key of a mirrored task is `task.runId`. When `existingTaskId` is null the
   * provider MUST find-or-create BY runId — it must NOT blindly create a new
   * item. The host's bounded timeout can reject the host await while a slow
   * first push STILL creates the upstream item; on the next sync the host
   * passes `existingTaskId: null` again, and a blind-create provider would
   * orphan the first item (a permanent duplicate the host can never address).
   * So the provider stamps `runId` onto the item it creates (Plane: a stable
   * external/sequence marker or a custom field) and, on a null-id upsert, looks
   * an existing item up by that marker first, updating it when found. Returns
   * the resolved task ref (the item's real id) the host persists in the
   * pm-link row, re-establishing the link even after a lost first push.
   */
  upsertTriggerTask(input: {
    task: PmTriggerTask;
    existingTaskId: string | null;
  }): Promise<PmTaskRef>;

  /**
   * Delete (unschedule) the mirrored work item for a run. `externalTaskId` is
   * the previously-persisted id. Idempotent: a 404 from the provider (already
   * gone) is a success, not an error.
   */
  deleteTriggerTask(input: {
    runId: string;
    externalTaskId: string;
  }): Promise<void>;

  /**
   * Read back the PM-side state of a mirrored task at EXECUTION time so the host
   * can honor a PM-side delete / reschedule / pause before firing the schedule
   * (cinatra#319 pre-execution check; cinatra#318 reconcile loop). This is the
   * inbound READ dual of `upsertTriggerTask`'s outbound write.
   *
   * Returns:
   *   - `PmTaskState` — the current PM-side snapshot (paused / cron / instant).
   *   - `null`        — the task was DELETED upstream (a definitive 404 for this
   *                     `externalTaskId`). The host tears down the local
   *                     schedule on this signal ONLY.
   *
   * FAIL-OPEN CONTRACT (load-bearing, codex#319): this runs on the execution
   * hot path. A provider outage / network error / timeout MUST surface as a
   * THROWN error, NEVER as `null` — the host maps a throw to "unreachable →
   * fail-open proceed" (the schedule fires) and maps ONLY a clean `null` to
   * "deleted → tear down". Returning `null` on a transient blip would wrongly
   * delete a live schedule. A provider must therefore distinguish a definitive
   * "task gone" (→ `null`) from "could not reach the PM API" (→ throw).
   */
  readTriggerTask(input: {
    runId: string;
    externalTaskId: string;
  }): Promise<PmTaskState | null>;
}
