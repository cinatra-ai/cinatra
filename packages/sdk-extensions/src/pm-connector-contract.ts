// Provider-agnostic PROJECT-MANAGEMENT (PM) CONTRACT (types only) — lives in
// the SDK so that PM provider extensions (plane-connector today; linear/jira
// later) and the host PM bridge share the contract WITHOUT importing each
// other by name.
//
// Every PM provider package implements `PmConnector`. The host PM bridge
// (src/lib/pm-integration-providers.ts) resolves the registered provider via
// the SDK registry's external resolver and delegates work-item ops to it.
// Provider packages import these symbols via `import type { ... }` only — the
// contract has no runtime code.
//
// SHAPE DECISIONS (derived from the Plane CE 1.3.1 on-the-wire smoke proof,
// cinatra#314/#315 discovery spike — the contract is provider-agnostic but its
// field choices are validated against a real PM REST surface):
//   - Dates are day-level ISO calendar strings (`YYYY-MM-DD`). The connector
//     maps these to the provider's native fields (Plane REST: start_date /
//     target_date). The contract deliberately uses neutral names
//     (`startDate` / `dueDate`) so the host never speaks a provider's wire
//     dialect; the connector owns the translation AND owns asserting the
//     provider echoed the date back (Plane silently drops `due_date` sent to
//     REST, so an echo-assert in the connector is mandatory — that concern
//     never leaks into this contract).
//   - A PM task is scoped to a (workspace, project) pair the connector resolves
//     from its own stored config; the host passes only neutral, run-derived
//     fields. The provider id + connection are NOT part of this contract — the
//     connector self-resolves them, exactly like the CRM provider.

export type PmConnectorId = string;

// ---------------------------------------------------------------------------
// Cinatra-shaped types (provider-agnostic surface)
// ---------------------------------------------------------------------------

/**
 * The cinatra-shaped project-management task — the neutral projection of a
 * provider work item (Plane work item / issue, Linear issue, Jira issue).
 */
export type PmTask = {
  /** Stable id from the PM provider (Plane work-item id, etc.). */
  id: string;
  /** Short human-readable title. */
  title: string;
  /** Longer description / body (provider-rendered as plain text or markup). */
  description?: string | null;
  /** Day-level ISO calendar date (`YYYY-MM-DD`) the work should start. */
  startDate?: string | null;
  /** Day-level ISO calendar date (`YYYY-MM-DD`) the work is due. The connector
   *  maps this to the provider's due field AND asserts the provider echoed it
   *  back (some providers silently drop an unknown date field). */
  dueDate?: string | null;
  /** Opaque provider state id/name (e.g. Plane state id). Omitted = provider
   *  default. */
  state?: string | null;
  /** Provider URL the task can be opened at, when the provider returns one. */
  url?: string | null;
};

/**
 * The link between a cinatra run-trigger and its mirrored PM task. The host
 * keys mirror operations by `runId`; the connector owns persisting the
 * runId→taskId mapping (in its own config rows) so the host never stores a
 * provider id.
 */
export type PmRunTaskRef = {
  /** cinatra run id the task mirrors. */
  runId: string;
  /** Provider work-item id, or null when no task is mapped yet. */
  taskId: string | null;
};

/** Neutral, run-derived fields the host hands the connector when a trigger is
 *  configured. The connector composes the provider work item from these. */
export type PmRunTaskInput = {
  /** cinatra run id (the mirror key). */
  runId: string;
  /** Trigger classification (`scheduled` | `recurring` | `immediate`). */
  triggerType: string;
  /** Resolved next-fire instant as an ISO datetime, when the trigger has one. */
  scheduledAt?: string | null;
  /** Cron expression for recurring triggers (display only). */
  cronExpression?: string | null;
  /** IANA timezone the schedule is interpreted in. */
  timezone?: string | null;
  /** Whether the trigger is enabled (a disabled trigger still mirrors, marked). */
  enabled?: boolean;
  /** Optional human label for the run (falls back to the run id). */
  title?: string | null;
};

// ---------------------------------------------------------------------------
// PmConnector — the verb surface every PM provider implements.
//
// Every method is async and fail-LOUD (throws on a provider error); the HOST
// bridge owns the fail-OPEN wrapping (a PM outage must never break a trigger).
// ---------------------------------------------------------------------------
export interface PmConnector {
  /** Stable provider id (e.g. "plane"). Matches the connector's stored config. */
  readonly providerId: PmConnectorId;

  /** Create or update the work item mirroring a run trigger, returning the
   *  mirrored task. Idempotent on `runId` — the connector upserts against its
   *  own runId→taskId mapping so repeated trigger configs do not duplicate. */
  upsertRunTask(input: PmRunTaskInput): Promise<PmTask>;

  /** Delete (or close) the work item mirroring `runId`. Idempotent — a no-op
   *  when no task is mapped. */
  deleteRunTask(input: { runId: string }): Promise<void>;

  /** Read the mirrored task for `runId`, or null when none is mapped. Used by
   *  the pre-execution PM-state check. */
  getRunTask(input: { runId: string }): Promise<PmTask | null>;
}
