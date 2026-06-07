/**
 * Unit tests for trigger-store CRUD.
 *
 * Tests the eight trigger-store behaviors:
 *   1. createOrUpdateRunTrigger inserts a row with sensible defaults
 *   2. createOrUpdateRunTrigger upserts (UPSERT semantics)
 *   3. readRunTriggerByRunId returns the latest row
 *   4. markTriggerReleasedInDb sets releasedAt to ~now
 *   5. deleteRunTriggerByRunId removes the row
 *   6. FK cascade — deleting parent agent_runs row removes the trigger row
 *   7. releasedAt PRESERVATION — config-only upserts must NOT clobber a
 *      releasedAt set by a prior markTriggerReleasedInDb call
 *   8. releasedAt EXPLICIT CLEAR — passing releasedAt: null clears the column
 *
 * Setup pattern follows the package convention: live DB connection driven by
 * SUPABASE_DB_URL/SUPABASE_SCHEMA from .env.local (already provisioned by
 * `cinatra setup branch`). Unique runIds via crypto.randomUUID() avoid
 * cross-test pollution.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  createOrUpdateRunTrigger,
  readRunTriggerByRunId,
  deleteRunTriggerByRunId,
  markTriggerReleasedInDb,
} from "../trigger-store";
import { createAgentRun, createAgentTemplate } from "../store";
import { db, agentBuilderPool } from "../db";
import { agentRuns, agentTemplates } from "../schema";

// Fixture orgId for the required agent template and run relationship.
const TEST_ORG_ID = "org-test";

// Track every fixture template id we create so we can clean up after the suite.
const createdTemplateIds: string[] = [];

// Helper: make a parent template + agent_runs row so the trigger FK has a target.
async function ensureParentRun(): Promise<string> {
  const templateId = `tmpl-${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: "trigger-store test fixture",
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName: `@test/${templateId}`,
    orgId: TEST_ORG_ID,
  });
  createdTemplateIds.push(templateId);
  const id = `test-trigger-${randomUUID()}`;
  await createAgentRun({
    id,
    templateId,
    inputParams: {},
    orgId: TEST_ORG_ID,
  });
  return id;
}

describe("trigger-store", () => {
  // Track every parent run id we create so we can clean up after the suite.
  const createdRunIds: string[] = [];

  beforeAll(() => {
    // Make sure the env points at a non-empty DB connection string. If this
    // throws the suite aborts cleanly with a helpful message rather than a
    // confusing "connection refused" deep inside drizzle.
    if (!process.env.SUPABASE_DB_URL) {
      throw new Error(
        "trigger-store.test.ts requires SUPABASE_DB_URL — run `cinatra setup branch` first.",
      );
    }
  });

  afterAll(async () => {
    // Best-effort cleanup so consecutive runs don't accumulate orphan rows.
    for (const id of createdRunIds) {
      try {
        await db.delete(agentRuns).where(eq(agentRuns.id, id));
      } catch {
        // ignore
      }
    }
    for (const id of createdTemplateIds) {
      try {
        await db.delete(agentTemplates).where(eq(agentTemplates.id, id));
      } catch {
        // ignore
      }
    }
    await agentBuilderPool.end().catch(() => {
      // pool may already be closed by another test; ignore
    });
  });

  it("createOrUpdateRunTrigger inserts a row with sensible defaults", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    const record = await createOrUpdateRunTrigger({
      runId,
      triggerType: "immediate",
    });

    expect(record.runId).toBe(runId);
    expect(record.triggerType).toBe("immediate");
    expect(record.enabled).toBe(true);
    expect(record.timezone).toBe("UTC");
    expect(record.releasedAt).toBeNull();
    expect(record.scheduledAt).toBeNull();
    expect(record.cronExpression).toBeNull();
    expect(record.jobSchedulerId).toBeNull();
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.updatedAt).toBeInstanceOf(Date);
  });

  it("createOrUpdateRunTrigger upserts on subsequent calls", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    await createOrUpdateRunTrigger({ runId, triggerType: "immediate" });

    const future = new Date(Date.now() + 60_000);
    const updated = await createOrUpdateRunTrigger({
      runId,
      triggerType: "scheduled",
      scheduledAt: future,
    });

    expect(updated.triggerType).toBe("scheduled");
    expect(updated.scheduledAt).not.toBeNull();
    expect(updated.scheduledAt!.getTime()).toBeCloseTo(future.getTime(), -2);

    // There must be only ONE row per runId (PK constraint).
    const readBack = await readRunTriggerByRunId(runId);
    expect(readBack?.triggerType).toBe("scheduled");
  });

  it("readRunTriggerByRunId returns the latest row", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    await createOrUpdateRunTrigger({
      runId,
      triggerType: "recurring",
      cronExpression: "0 9 * * MON",
      timezone: "Europe/London",
    });

    const row = await readRunTriggerByRunId(runId);
    expect(row).not.toBeNull();
    expect(row!.triggerType).toBe("recurring");
    expect(row!.cronExpression).toBe("0 9 * * MON");
    expect(row!.timezone).toBe("Europe/London");
  });

  it("markTriggerReleasedInDb sets releasedAt to ~now", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    await createOrUpdateRunTrigger({ runId, triggerType: "immediate" });

    const before = Date.now();
    await markTriggerReleasedInDb(runId);
    const after = Date.now();

    const row = await readRunTriggerByRunId(runId);
    expect(row).not.toBeNull();
    expect(row!.releasedAt).not.toBeNull();
    const releasedMs = row!.releasedAt!.getTime();
    expect(releasedMs).toBeGreaterThanOrEqual(before - 5_000);
    expect(releasedMs).toBeLessThanOrEqual(after + 5_000);
  });

  it("deleteRunTriggerByRunId removes the row", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    await createOrUpdateRunTrigger({ runId, triggerType: "immediate" });
    expect(await readRunTriggerByRunId(runId)).not.toBeNull();

    await deleteRunTriggerByRunId(runId);
    expect(await readRunTriggerByRunId(runId)).toBeNull();
  });

  it("FK cascade — deleting parent agent_runs row removes the trigger row", async () => {
    const runId = await ensureParentRun();
    // Don't push to createdRunIds — we delete it as part of the test.

    await createOrUpdateRunTrigger({ runId, triggerType: "immediate" });
    expect(await readRunTriggerByRunId(runId)).not.toBeNull();

    // Delete parent — FK ON DELETE CASCADE should remove the trigger row.
    await db.delete(agentRuns).where(eq(agentRuns.id, runId));

    expect(await readRunTriggerByRunId(runId)).toBeNull();
  });

  it("releasedAt is PRESERVED across config-only upserts (no input.releasedAt)", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    // 1. Create the trigger row.
    await createOrUpdateRunTrigger({ runId, triggerType: "immediate" });

    // 2. Mark it released — sets releasedAt to NOW.
    await markTriggerReleasedInDb(runId);
    const released = await readRunTriggerByRunId(runId);
    expect(released?.releasedAt).not.toBeNull();
    const originalReleasedAtMs = released!.releasedAt!.getTime();

    // 3. Re-upsert the SAME config but with a new jobSchedulerId. This is
    // the immediate-trigger code path: setRunTrigger upserts twice (once
    // before BullMQ scheduling, once after with the BullMQ id). The second
    // upsert MUST NOT clobber the releasedAt the in-between markReleased set.
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "immediate",
      jobSchedulerId: "fake-bullmq-id",
    });

    const after = await readRunTriggerByRunId(runId);
    expect(after?.releasedAt).not.toBeNull();
    expect(after!.releasedAt!.getTime()).toBe(originalReleasedAtMs);
    expect(after!.jobSchedulerId).toBe("fake-bullmq-id");
  });

  it("releasedAt is EXPLICITLY CLEARED when input.releasedAt === null", async () => {
    const runId = await ensureParentRun();
    createdRunIds.push(runId);

    await createOrUpdateRunTrigger({ runId, triggerType: "recurring", cronExpression: "0 9 * * MON" });
    await markTriggerReleasedInDb(runId);
    expect((await readRunTriggerByRunId(runId))?.releasedAt).not.toBeNull();

    // Explicit null clears the column when re-arming a released recurring trigger.
    await createOrUpdateRunTrigger({
      runId,
      triggerType: "recurring",
      cronExpression: "0 9 * * MON",
      releasedAt: null,
    });

    const cleared = await readRunTriggerByRunId(runId);
    expect(cleared?.releasedAt).toBeNull();
  });
});
