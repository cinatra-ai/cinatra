import "server-only";

// ---------------------------------------------------------------------------
// Actor-aware trigger CRUD service.
//
// Single source of truth for trigger configuration's auth + business logic.
// Server-action wrappers in run-actions.ts resolve the Better Auth session
// into a TriggerActorContext, then delegate here. MCP handlers in
// mcp/handlers.ts construct the same envelope from `request.actor` and
// delegate. Both surfaces hit identical enforcement code — no drift.
//
// Design rule: this module NEVER touches the Better Auth session.
// Programmatic MCP clients have no browser session, only the actor envelope
// on the request. The server-action wrapper is the ONLY place that
// translates the session into an actor.
// ---------------------------------------------------------------------------

import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
  deleteRunTriggerByRunId,
  type TriggerType,
  type TriggerRecord,
} from "./trigger-store";
import { scheduleTrigger, cancelTriggerSchedule } from "./trigger-schedule";
import {
  transitionRunStatus,
  RunTransitionError,
  readAgentRunById,
} from "./store";
// Schedule↔PM-task sync (cinatra#317). packages/agents calls OUT to the
// host-owned PM provider bridge via the Next.js "@/lib/*" alias (Option 2 / the
// host-owned PM provider bridge); it NEVER imports the SDK PM registry or any
// Plane code. Both functions are fail-open — the trigger lifecycle is
// authoritative for the LOCAL schedule and never throws on a PM outage.
// trigger-service.ts is server-only and compiles inside the host bundle, so
// "@/lib/*" resolves at runtime (the same indirection list-picker-actions.ts /
// external-mcp-caller.ts use for host-resolved outbound integration).
import {
  syncRunTriggerPmTask,
  deleteRunTriggerPmTask,
} from "@/lib/pm-integration-providers";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Actor envelope accepted by the service layer. Mirrors the MCP request
 * actor shape; server-action callers construct an equivalent envelope from
 * the Better Auth session.
 *
 * - `userId` MUST be present for any non-public operation. The service
 *   refuses requests with empty userId (defense in depth: even if a
 *   handler somehow forwards an empty actor, the service still rejects).
 * - `role === "admin"` enables ownership bypass for read/cancel paths
 *   (operations support). For setRunTrigger this is a no-op — admins
 *   use the separate `releaseTriggerNow` admin-only override.
 * - `source` is for audit logging only and is not interpreted by this
 *   layer ("ui" | "mcp" | "worker" | "scheduler" | etc).
 */
export type TriggerActorContext = {
  userId: string;
  role?: string | null;
  source?: string;
};

export type SetTriggerForActorArgs = {
  runId: string;
  triggerType: TriggerType;
  scheduledAt?: string;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
};

export type SetTriggerForActorResult =
  | { ok: true; runId: string; jobSchedulerId: string | null }
  | { ok: false; error: string };

export type GetTriggerForActorResult =
  | { ok: true; trigger: TriggerRecord | null }
  | { ok: false; error: string };

export type DeleteTriggerForActorResult =
  | { ok: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a timezone-naive "YYYY-MM-DDTHH:MM" (or "YYYY-MM-DDTHH:MM:SS")
 * string — as produced by an HTML datetime-local input — to a UTC epoch ms
 * value, interpreting the wall-clock time in the given IANA timezone.
 *
 * Why not `new Date(naive)`? Node.js parses naive strings in local time
 * (UTC on servers), ignoring the user-selected timezone. This helper uses
 * the Intl.DateTimeFormat API (no external dependency) to resolve the
 * offset at the exact moment, handling DST transitions correctly.
 */
function naiveDatetimeToUtcMs(naive: string, timezone: string): number {
  // Normalise to full seconds precision.
  const padded = naive.length === 16 ? naive + ":00" : naive;
  // Treat the string as UTC to get a reference epoch.
  const asUtcMs = new Date(padded + "Z").getTime();
  if (Number.isNaN(asUtcMs)) return NaN;
  // Re-format that reference epoch in the target timezone to find its
  // wall-clock representation there.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(asUtcMs));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const tzYear = get("year");
  const tzMonth = get("month");
  const tzDay = get("day");
  const rawHour = get("hour");
  // hour12: false can return "24" for midnight — normalise to "00".
  const tzHour = rawHour === "24" ? "00" : rawHour;
  const tzMinute = get("minute");
  const tzSecond = get("second");
  // Treat the reformatted parts as UTC to get the timezone's interpretation
  // of the reference epoch.
  const inTzMs = new Date(
    `${tzYear}-${tzMonth}-${tzDay}T${tzHour}:${tzMinute}:${tzSecond}Z`,
  ).getTime();
  // The offset is the difference; adding it back converts the naive input
  // (interpreted as that timezone) to a true UTC epoch.
  const offsetMs = asUtcMs - inTzMs;
  return asUtcMs + offsetMs;
}

function isOwnerOrAdmin(
  actor: TriggerActorContext,
  runOwnerId: string | null,
): boolean {
  if (actor.role === "admin") return true;
  // Unowned runs (runBy: null) require admin — any authenticated user should
  // NOT be able to schedule or delete triggers on runs they did not create.
  // The old "bypass for legacy runs" rationale does not apply to trigger ops
  // which have permanent schedule effects.
  if (!runOwnerId) return false;
  return runOwnerId === actor.userId;
}

// ---------------------------------------------------------------------------
// setRunTriggerForActor — configure a trigger for `runId` on behalf of `actor`.
// ---------------------------------------------------------------------------
/**
 * Configure a trigger for `runId` on behalf of `actor`.
 *
 * Enforces ownership; validates cron/scheduledAt server-side; cancels any
 * prior schedule BEFORE upserting (no orphan jobs); flips run status
 * pending_input → armed (with pending_trigger → armed fallback) for
 * scheduled/recurring trigger types.
 *
 * Same code path is used by server actions and MCP handlers — the actor
 * envelope is the only auth input.
 */
export async function setRunTriggerForActor(
  actor: TriggerActorContext,
  args: SetTriggerForActorArgs,
): Promise<SetTriggerForActorResult> {
  if (!actor.userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };
  if (!isOwnerOrAdmin(actor, run.runBy ?? null)) {
    return { ok: false, error: "forbidden" };
  }

  // Server-side validation — defence in depth + consistency between
  // server-action and MCP entry points.
  if (args.triggerType === "recurring") {
    if (!args.cronExpression) {
      return {
        ok: false,
        error: "cronExpression is required for recurring triggers",
      };
    }
    if (args.cronExpression.length > 256) {
      return {
        ok: false,
        error: "cronExpression too long (max 256 chars)",
      };
    }
    try {
      const parser = await import("cron-parser");
      const parseExpression =
        (
          parser as {
            default?: { parseExpression?: (e: string, o?: unknown) => unknown };
          }
        ).default?.parseExpression ??
        (parser as { parseExpression?: (e: string, o?: unknown) => unknown })
          .parseExpression;
      if (typeof parseExpression !== "function") {
        return { ok: false, error: "cron-parser unavailable" };
      }
      parseExpression(args.cronExpression, { tz: args.timezone ?? "UTC" });
    } catch (err) {
      return {
        ok: false,
        error: `invalid cron expression: ${(err as Error).message}`,
      };
    }
  }
  const tz = args.timezone ?? "UTC";

  if (args.triggerType === "scheduled") {
    if (!args.scheduledAt) {
      return {
        ok: false,
        error: "scheduledAt is required for scheduled triggers",
      };
    }
    // Interpret the naive datetime-local string in the user's selected
    // timezone rather than the server's local time (UTC on Node servers).
    const ts = naiveDatetimeToUtcMs(args.scheduledAt, tz);
    if (Number.isNaN(ts)) {
      return { ok: false, error: "scheduledAt is not a valid ISO datetime" };
    }
    if (ts <= Date.now()) {
      return { ok: false, error: "scheduledAt must be in the future" };
    }
  }

  // Read existing row first → cancel old schedule → upsert (no orphan jobs).
  const existing = await readRunTriggerByRunId(args.runId);
  const oldJobSchedulerId = existing?.jobSchedulerId ?? null;
  const oldTriggerType = existing?.triggerType ?? null;
  if (oldJobSchedulerId && oldTriggerType) {
    try {
      await cancelTriggerSchedule({
        jobSchedulerId: oldJobSchedulerId,
        triggerType: oldTriggerType,
      });
    } catch (err) {
      console.warn(
        "[setRunTriggerForActor] cancel of prior schedule failed (continuing)",
        args.runId,
        err,
      );
    }
  }

  // Upsert (no jobSchedulerId yet — set after scheduling).
  // NOTE: do NOT pass `releasedAt` — the store omits it from the SET clause
  // when undefined, preserving any prior value (matches the immediate-trigger
  // double-upsert path that calls markTriggerReleased between upserts).
  await createOrUpdateRunTrigger({
    runId: args.runId,
    triggerType: args.triggerType,
    scheduledAt: args.scheduledAt ? new Date(naiveDatetimeToUtcMs(args.scheduledAt, tz)) : null,
    cronExpression: args.cronExpression ?? null,
    timezone: tz,
    enabled: args.enabled ?? true,
    jobSchedulerId: null,
  });

  // Register the new schedule (compensate on failure).
  let scheduleResult: { jobSchedulerId: string | null };
  try {
    scheduleResult = await scheduleTrigger({
      runId: args.runId,
      triggerType: args.triggerType,
      scheduledAt: args.scheduledAt ? new Date(naiveDatetimeToUtcMs(args.scheduledAt, tz)) : undefined,
      cronExpression: args.cronExpression,
      timezone: tz,
    });
  } catch (err) {
    await deleteRunTriggerByRunId(args.runId).catch((cleanupErr) => {
      console.error(
        "[setRunTriggerForActor] cleanup after schedule failure failed",
        args.runId,
        cleanupErr,
      );
    });
    return {
      ok: false,
      error: `schedule failed: ${(err as Error).message}`,
    };
  }

  // Persist final form (jobSchedulerId set). Same releasedAt-preservation note.
  await createOrUpdateRunTrigger({
    runId: args.runId,
    triggerType: args.triggerType,
    scheduledAt: args.scheduledAt ? new Date(naiveDatetimeToUtcMs(args.scheduledAt, tz)) : null,
    cronExpression: args.cronExpression ?? null,
    timezone: tz,
    enabled: args.enabled ?? true,
    jobSchedulerId: scheduleResult.jobSchedulerId,
  });

  // Flip status based on trigger type:
  //   scheduled / recurring → pending_input (or pending_trigger) → armed
  //                           (gate will be opened later by the release job)
  //   immediate             → gate already opened by scheduleTrigger above;
  //                           transition directly to queued so the dispatcher
  //                           can pick up the run.
  if (args.triggerType === "scheduled" || args.triggerType === "recurring") {
    try {
      await transitionRunStatus(args.runId, "pending_input", "armed");
    } catch (err) {
      if (
        err instanceof RunTransitionError &&
        err.code === "stale_from_status"
      ) {
        try {
          await transitionRunStatus(args.runId, "pending_trigger", "armed");
        } catch (err2) {
          if (
            err2 instanceof RunTransitionError &&
            err2.code === "stale_from_status"
          ) {
            console.log(
              `[setRunTriggerForActor] run ${args.runId} not in pending_input/pending_trigger — leaving status as-is`,
            );
          } else {
            throw err2;
          }
        }
      } else {
        throw err;
      }
    }
  } else if (args.triggerType === "immediate") {
    // Gate is already open; transition directly to queued.
    try {
      await transitionRunStatus(args.runId, "pending_input", "queued");
    } catch (err) {
      if (
        !(err instanceof RunTransitionError && err.code === "stale_from_status")
      ) {
        throw err;
      }
      // stale_from_status means the run was already in another status
      // (e.g. was reset to pending_trigger or already queued). Log and
      // continue — gate is already open.
      console.log(
        `[setRunTriggerForActor] immediate: run ${args.runId} not in pending_input — status left as-is`,
      );
    }
  }

  // HOOK POINT A (cinatra#317) — outbound PM mirror of the schedule-DEFINING
  // trigger, AFTER the final createOrUpdateRunTrigger (jobSchedulerId persisted)
  // and the status flip have succeeded. Fail-open: the local schedule is already
  // durable, so a PM outage must never fail this call (the bridge swallows + logs
  // its own errors, and the .catch is defense-in-depth). Mirrors the trigger
  // CONFIG, not the recurring child runs.
  await syncRunTriggerPmTask({
    runId: args.runId,
    triggerType: args.triggerType,
    scheduledAt: args.scheduledAt
      ? new Date(naiveDatetimeToUtcMs(args.scheduledAt, tz)).toISOString()
      : null,
    cronExpression: args.cronExpression ?? null,
    timezone: tz,
    enabled: args.enabled ?? true,
  }).catch((err) => {
    // runId + err passed as ARGUMENTS (not interpolated into the format string)
    // so a runId is never treated as a console format spec (js/tainted-format-string).
    console.warn(
      "[setRunTriggerForActor] PM mirror failed (schedule unaffected) for run",
      args.runId,
      err,
    );
  });

  return {
    ok: true,
    runId: args.runId,
    jobSchedulerId: scheduleResult.jobSchedulerId,
  };
}

// ---------------------------------------------------------------------------
// getRunTriggerForActor — read a run's trigger config on behalf of `actor`.
// ---------------------------------------------------------------------------
/**
 * Read a run's trigger config on behalf of `actor`.
 *
 * Enforces ownership FIRST (read parent agent_run, verify owner) BEFORE
 * returning trigger metadata. Prevents information disclosure of scheduled
 * times / cron expressions / releasedAt from non-owners and keeps trigger
 * metadata behind the same ownership check.
 *
 * Same code path is used by server actions and MCP handlers — direct calls
 * to readRunTriggerByRunId from the MCP layer would bypass this check.
 */
export async function getRunTriggerForActor(
  actor: TriggerActorContext,
  runId: string,
): Promise<GetTriggerForActorResult> {
  if (!actor.userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(runId);
  if (!run) return { ok: false, error: "run not found" };
  if (!isOwnerOrAdmin(actor, run.runBy ?? null)) {
    return { ok: false, error: "forbidden" };
  }

  const trigger = await readRunTriggerByRunId(runId);
  return { ok: true, trigger };
}

// ---------------------------------------------------------------------------
// deleteRunTriggerForActor — cancel a run's trigger on behalf of `actor`.
// ---------------------------------------------------------------------------
/**
 * Cancel a run's trigger on behalf of `actor`.
 *
 * Enforces ownership; cancels BullMQ schedule; deletes the row; flips run
 * status armed → stopped for scheduled/recurring trigger types.
 *
 * Idempotent: if there is no trigger row, returns ok without side effects.
 */
export async function deleteRunTriggerForActor(
  actor: TriggerActorContext,
  args: { runId: string },
): Promise<DeleteTriggerForActorResult> {
  if (!actor.userId) return { ok: false, error: "unauthorized" };

  const run = await readAgentRunById(args.runId);
  if (!run) return { ok: false, error: "run not found" };
  if (!isOwnerOrAdmin(actor, run.runBy ?? null)) {
    return { ok: false, error: "forbidden" };
  }

  const trigger = await readRunTriggerByRunId(args.runId);
  if (!trigger) return { ok: true };

  try {
    await cancelTriggerSchedule({
      jobSchedulerId: trigger.jobSchedulerId,
      triggerType: trigger.triggerType,
    });
  } catch (err) {
    console.warn(
      "[deleteRunTriggerForActor] cancel of BullMQ job failed (continuing with DB delete)",
      args.runId,
      err,
    );
  }
  await deleteRunTriggerByRunId(args.runId);

  if (
    trigger.triggerType === "scheduled" ||
    trigger.triggerType === "recurring"
  ) {
    try {
      await transitionRunStatus(args.runId, "armed", "stopped");
    } catch (err) {
      if (
        err instanceof RunTransitionError &&
        err.code === "stale_from_status"
      ) {
        console.log(
          `[deleteRunTriggerForActor] run ${args.runId} not in armed state — leaving status as-is`,
        );
      } else {
        throw err;
      }
    }
  }

  // HOOK POINT B (cinatra#317) — unschedule/delete the mirrored PM work item
  // AFTER the local trigger row is deleted and the armed→stopped transition has
  // run. Fail-open: the local trigger is already gone, so a PM outage must never
  // fail this call (the bridge leaves the pm-link row for the reconcile loop and
  // swallows + logs its own errors; the .catch is defense-in-depth).
  await deleteRunTriggerPmTask({ runId: args.runId }).catch((err) => {
    // runId + err passed as ARGUMENTS (not interpolated into the format string)
    // so a runId is never treated as a console format spec (js/tainted-format-string).
    console.warn(
      "[deleteRunTriggerForActor] PM unschedule failed (trigger already deleted) for run",
      args.runId,
      err,
    );
  });

  return { ok: true };
}
