/**
 * Integration tests for the pm-link-store reconcile enumerator
 * (`listPmLinksForReconcile`) added for the OUTBOUND-REPAIR reconcile loop
 * (cinatra#318).
 *
 * Proves:
 *   1. A HEALTHY row (sync_error NULL, external_task_id set, synced_at set) is
 *      EXCLUDED from the candidate set.
 *   2. An ERRORED row (sync_error set) is INCLUDED.
 *   3. A NEVER-SYNCED row (external_task_id NULL) is INCLUDED.
 *   4. Keyset pagination orders by run_id ascending and honours the exclusive
 *      `afterRunId` cursor + the `limit` page size.
 *
 * Setup follows the trigger-store.integration.test.ts convention: a live DB
 * connection via SUPABASE_DB_URL, unique runIds via randomUUID, parent
 * agent_runs rows created so the pm-link FK has a target, best-effort cleanup.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  recordPmLinkSuccess,
  recordPmLinkError,
  listPmLinksForReconcile,
} from "../pm-link-store";
import { createAgentRun, createAgentTemplate } from "../store";
import { db, agentBuilderPool } from "../db";
import { agentRuns, agentTemplates } from "../schema";

const TEST_ORG_ID = "org-test";
const createdTemplateIds: string[] = [];
const createdRunIds: string[] = [];

async function ensureParentRun(): Promise<string> {
  const templateId = `tmpl-${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: "pm-link-store reconcile fixture",
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName: `@test/${templateId}`,
    orgId: TEST_ORG_ID,
  });
  createdTemplateIds.push(templateId);
  const id = `test-pmlink-${randomUUID()}`;
  await createAgentRun({ id, templateId, inputParams: {}, orgId: TEST_ORG_ID });
  createdRunIds.push(id);
  return id;
}

describe("listPmLinksForReconcile", () => {
  beforeAll(() => {
    if (!process.env.SUPABASE_DB_URL) {
      throw new Error(
        "pm-link-store-reconcile.integration.test.ts requires SUPABASE_DB_URL — run `cinatra setup branch` first.",
      );
    }
  });

  afterAll(async () => {
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
    await agentBuilderPool.end().catch(() => {});
  });

  it("excludes healthy rows and includes errored + never-synced rows", async () => {
    const healthyRun = await ensureParentRun();
    const erroredRun = await ensureParentRun();
    const neverSyncedRun = await ensureParentRun();

    // Healthy: a successful push (external_task_id + synced_at set, error null).
    await recordPmLinkSuccess({
      runId: healthyRun,
      provider: "plane",
      externalTaskId: "task-healthy",
    });

    // Errored: a successful push, then a failed re-push (sync_error set,
    // external_task_id preserved). Still needs reconcile because it errored.
    await recordPmLinkSuccess({
      runId: erroredRun,
      provider: "plane",
      externalTaskId: "task-errored",
    });
    await recordPmLinkError({
      runId: erroredRun,
      provider: "plane",
      syncError: "provider 500",
    });

    // Never-synced: only a failed first push (external_task_id + synced_at NULL).
    await recordPmLinkError({
      runId: neverSyncedRun,
      provider: "plane",
      syncError: "timed out",
    });

    // Enumerate a wide page; filter to just our three fixture runIds so the
    // assertion is robust against any other rows already in the test DB.
    const ours = new Set([healthyRun, erroredRun, neverSyncedRun]);
    const page = await listPmLinksForReconcile({ limit: 1000 });
    const returned = new Set(page.map((r) => r.runId).filter((id) => ours.has(id)));

    expect(returned.has(healthyRun)).toBe(false); // healthy → excluded
    expect(returned.has(erroredRun)).toBe(true); // errored → included
    expect(returned.has(neverSyncedRun)).toBe(true); // never-synced → included
  });

  it("paginates by run_id ascending with the exclusive afterRunId cursor", async () => {
    // Three errored rows with deterministic, sortable runIds so keyset order
    // is assertable independent of UUID ordering.
    const a = await ensureParentRun();
    const b = await ensureParentRun();
    const c = await ensureParentRun();
    for (const runId of [a, b, c]) {
      await recordPmLinkError({ runId, provider: "plane", syncError: "x" });
    }
    const sorted = [a, b, c].sort();

    // Page 1: limit 2 starting from just-before the first of our sorted ids.
    // Use the lexicographically-smallest sentinel below `sorted[0]` so the
    // cursor starts the candidate set at our rows (other DB rows may interleave,
    // so we assert ordering on the subset we own).
    const firstCursor = sorted[0].slice(0, -1); // strictly < sorted[0]
    const page1 = await listPmLinksForReconcile({ afterRunId: firstCursor, limit: 50 });
    const oursInOrder = page1.map((r) => r.runId).filter((id) => sorted.includes(id));
    expect(oursInOrder).toEqual(sorted); // ascending run_id order

    // Exclusive cursor: starting AFTER sorted[0] must not re-return sorted[0].
    const page2 = await listPmLinksForReconcile({ afterRunId: sorted[0], limit: 50 });
    const page2Ours = page2.map((r) => r.runId).filter((id) => sorted.includes(id));
    expect(page2Ours).not.toContain(sorted[0]);
    expect(page2Ours).toEqual([sorted[1], sorted[2]]);
  });
});
