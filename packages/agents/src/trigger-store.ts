import "server-only";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { agentRunTriggers } from "./schema";

// ---------------------------------------------------------------------------
// trigger-store CRUD
// ---------------------------------------------------------------------------
// Pure DB layer for the agent_run_triggers table. The Redis fast-path lives
// in a separate trigger-gate.ts — DO NOT couple Redis writes here.
// ---------------------------------------------------------------------------

export type TriggerType = "immediate" | "scheduled" | "recurring";

export type TriggerRecord = {
  runId: string;
  triggerType: TriggerType;
  scheduledAt: Date | null;
  cronExpression: string | null;
  timezone: string;
  enabled: boolean;
  releasedAt: Date | null;
  /** The last time a RECURRING tick actually fired this schedule
   *  (cinatra#2972). Null for a schedule that has never fired, and null for
   *  every one-off — a one-off's firing is `releasedAt`. */
  lastFiredAt: Date | null;
  /** When **Cancel schedule** stopped this recurring schedule (cinatra#2972).
   *  Null for every schedule nobody stopped. The ONE act that writes it is
   *  `stopRunTriggerInDb`, which is why it can be read as that act — unlike
   *  `enabled`, which the trigger MCP tool also writes. */
  stoppedAt: Date | null;
  jobSchedulerId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOrUpdateTriggerInput = {
  runId: string;
  triggerType: TriggerType;
  scheduledAt?: Date | null;
  cronExpression?: string | null;
  timezone?: string;
  enabled?: boolean;
  jobSchedulerId?: string | null;
  // Explicit override semantics for releasedAt:
  //   undefined = preserve existing value (default for config updates)
  //   null      = explicitly clear (e.g. when re-arming an already-released trigger)
  //   Date      = explicitly set
  releasedAt?: Date | null;
};

function deserialize(row: typeof agentRunTriggers.$inferSelect): TriggerRecord {
  return {
    runId:          row.runId,
    triggerType:    row.triggerType as TriggerType,
    scheduledAt:    row.scheduledAt,
    cronExpression: row.cronExpression,
    timezone:       row.timezone,
    enabled:        row.enabled,
    releasedAt:     row.releasedAt,
    lastFiredAt:    row.lastFiredAt,
    stoppedAt:      row.stoppedAt,
    jobSchedulerId: row.jobSchedulerId,
    createdAt:      row.createdAt,
    updatedAt:      row.updatedAt,
  };
}

/**
 * Upsert a trigger configuration row keyed by runId.
 *
 * `input.releasedAt` follows patch-style semantics:
 *   - undefined (default) → preserve any existing releasedAt on update
 *   - null               → explicitly clear releasedAt
 *   - Date               → explicitly set releasedAt
 *
 * This prevents the immediate-trigger double-upsert
 * (setRunTrigger → markTriggerReleased → setRunTrigger) from silently
 * clobbering the releasedAt timestamp set in between.
 */
export async function createOrUpdateRunTrigger(
  input: CreateOrUpdateTriggerInput,
): Promise<TriggerRecord> {
  const now = new Date();

  // Base values written on every upsert (config replacement).
  // releasedAt and stoppedAt are intentionally OMITTED from this object: a config update
  // (e.g. setRunTrigger upserts twice — once with jobSchedulerId:null then
  // again with the BullMQ id) must NOT clobber a prior releasedAt set by
  // markTriggerReleasedInDb (immediate-trigger flow). Callers that explicitly
  // want to clear/set releasedAt pass it via `input.releasedAt`. `stoppedAt`
  // (cinatra#2972) has no such escape hatch at all: `stopRunTriggerInDb` is its
  // only writer, so a Save-changes upsert landing after a Cancel schedule
  // cannot resurrect the schedule the person stopped — the save is refused by
  // the guard, and even if it were not, the stamp would still stand.
  const setValues: Record<string, unknown> = {
    runId:          input.runId,
    triggerType:    input.triggerType,
    scheduledAt:    input.scheduledAt ?? null,
    cronExpression: input.cronExpression ?? null,
    timezone:       input.timezone ?? "UTC",
    enabled:        input.enabled ?? true,
    jobSchedulerId: input.jobSchedulerId ?? null,
    updatedAt:      now,
  };

  // Only include releasedAt in the SET clause when explicitly provided.
  // `input.releasedAt === null` is treated as an explicit clear; `undefined`
  // means "preserve existing value" (per existing patch-style conventions
  // in store.ts:updateAgentRun*).
  if (input.releasedAt !== undefined) {
    setValues.releasedAt = input.releasedAt;
  }

  // Insert values include createdAt; releasedAt defaults to null on insert
  // unless explicitly provided.
  const insertValues: Record<string, unknown> = {
    ...setValues,
    createdAt: now,
  };
  if (input.releasedAt === undefined) {
    insertValues.releasedAt = null;
  }

  const [row] = await db
    .insert(agentRunTriggers)
    .values(insertValues as typeof agentRunTriggers.$inferInsert)
    .onConflictDoUpdate({
      target: agentRunTriggers.runId,
      set: setValues,
    })
    .returning();

  if (!row) {
    throw new Error(
      `createOrUpdateRunTrigger: no row returned for ${input.runId}`,
    );
  }
  return deserialize(row);
}

export async function readRunTriggerByRunId(
  runId: string,
): Promise<TriggerRecord | null> {
  const [row] = await db
    .select()
    .from(agentRunTriggers)
    .where(eq(agentRunTriggers.runId, runId));
  return row ? deserialize(row) : null;
}

export async function deleteRunTriggerByRunId(runId: string): Promise<void> {
  await db.delete(agentRunTriggers).where(eq(agentRunTriggers.runId, runId));
}

export async function markTriggerReleasedInDb(runId: string): Promise<void> {
  const now = new Date();
  await db
    .update(agentRunTriggers)
    .set({ releasedAt: now, updatedAt: now })
    .where(eq(agentRunTriggers.runId, runId));
}

/**
 * Stamp a RECURRING schedule as having fired (cinatra#2972).
 *
 * Written by the tick, once per fire. It is deliberately NOT `releasedAt`: that
 * stamp opens the schedule-defining run's own side-effect gate, and a recurring
 * tick must never do that — it starts a COPY. This column records only that the
 * schedule has produced at least one run, which is the reading plan (A) §7.2
 * keys **Cancel schedule** and the still-editable scheduler to.
 */
export async function markTriggerFiredInDb(runId: string): Promise<void> {
  const now = new Date();
  await db
    .update(agentRunTriggers)
    .set({ lastFiredAt: now, updatedAt: now })
    .where(eq(agentRunTriggers.runId, runId));
}

/**
 * STOP a schedule without deleting it (cinatra#2972).
 *
 * Plan (A) §7.2 as amended 2026-08-25: **Cancel schedule** "stops the recurring
 * schedule and then makes the scheduler non-editable". It is NOT the delete
 * `deleteRunTriggerByRunId` performs: the row stays, so the person can still
 * read the schedule that was stopped, and the run's own status is untouched —
 * nothing is paused.
 *
 * TWO WRITES, TWO PURPOSES, AND NEITHER IS THE OTHER'S SIGNAL:
 *
 *   · `stopped_at` IS the state. It is written by this function and by nothing
 *     else, which is what lets a reader read it as "somebody pressed Cancel
 *     schedule". `enabled` could not carry that meaning: the
 *     `trigger_config_set` MCP tool already writes it, for any trigger of any
 *     type, so reading a false `enabled` as "stopped" would reinterpret rows
 *     something else disabled — and then permanently refuse to re-arm them.
 *   · `enabled: false` is BELT AND BRACES. The release job re-reads it at fire
 *     time and refuses a disabled trigger, so a job that outlives the cancel
 *     still does not fire, without that path having to learn a second column.
 *
 * `jobSchedulerId` IS DELIBERATELY LEFT ALONE, and that is a fix rather than an
 * omission (codex round 3). The stop stamps BEFORE it cancels, so the cancel can
 * still fail — and a stopped row with the id erased leaves a scheduler nothing
 * can name: every tick reads the stamp, refuses to fire, and has no id to
 * unschedule with, so it ticks into a refusal forever. Keeping the id is what
 * lets the first such tick tear the orphan down. After a SUCCESSFUL cancel the
 * id names a scheduler that no longer exists, which is inert: nothing reads it
 * except that teardown, and no tick arrives to run it.
 *
 * `updatedAt` moves; nothing else does — in particular the schedule itself
 * stays readable, because stopping is not deleting.
 */
export async function stopRunTriggerInDb(runId: string): Promise<void> {
  const now = new Date();
  await db
    .update(agentRunTriggers)
    .set({ stoppedAt: now, enabled: false, updatedAt: now })
    .where(eq(agentRunTriggers.runId, runId));
}
