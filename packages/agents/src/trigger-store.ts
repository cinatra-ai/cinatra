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
  // releasedAt is intentionally OMITTED from this object: a config update
  // (e.g. setRunTrigger upserts twice — once with jobSchedulerId:null then
  // again with the BullMQ id) must NOT clobber a prior releasedAt set by
  // markTriggerReleasedInDb (immediate-trigger flow). Callers that explicitly
  // want to clear/set releasedAt pass it via `input.releasedAt`.
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
