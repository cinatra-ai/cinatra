/**
 * Race-safe idempotent createAgentRun.
 *
 * The release-workflows reconciler dispatches agent_task work at-least-once
 * (BullMQ retries + crash recovery). createAgentRun accepts a run-scoped
 * idempotencyKey (`${workflowId}:${taskId}:${attemptNo}`); a redispatch of the
 * SAME attempt must resolve to the SAME child run (via the partial-unique index
 * agent_runs_idempotency_key_uniq), while a retry (new key) spawns a fresh run.
 * A key reused with mismatched provenance fails closed.
 *
 * DB-gated: skips when SUPABASE_DB_URL is unset (matches store-org-required).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");
const q = (s: string) => s.replaceAll('"', '""');

beforeAll(async () => {
  if (!hasDb) return;
  // Defensive: ensure the idempotency columns + partial unique index exist
  // (mirrors src/lib/drizzle-store.ts; idempotent — safe on an already-migrated schema).
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  await c.query(`ALTER TABLE "${q(SCHEMA)}"."agent_runs" ADD COLUMN IF NOT EXISTS idempotency_key text`);
  await c.query(`ALTER TABLE "${q(SCHEMA)}"."agent_runs" ADD COLUMN IF NOT EXISTS workflow_id text`);
  await c.query(`ALTER TABLE "${q(SCHEMA)}"."agent_runs" ADD COLUMN IF NOT EXISTS workflow_task_id text`);
  await c.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_idempotency_key_uniq ON "${q(SCHEMA)}"."agent_runs" (idempotency_key) WHERE idempotency_key IS NOT NULL`,
  );
  await c.end();
}, 30_000);

async function makeTemplate(): Promise<string> {
  const { createAgentTemplate } = await import("../store");
  const templateId = `t_${randomUUID()}`;
  await createAgentTemplate({
    id: templateId,
    name: `idem-${randomUUID().slice(0, 8)}`,
    sourceNl: "test",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
  });
  return templateId;
}

describe.skipIf(!hasDb)("createAgentRun — idempotent dispatch", () => {
  it("same idempotency key resolves to the SAME child run (at-least-once redispatch)", async () => {
    const { createAgentRun } = await import("../store");
    const templateId = await makeTemplate();
    const key = `wf:${randomUUID()}:task:1`;
    const first = await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem",
      idempotencyKey: key, workflowId: "wf-1", workflowTaskId: "task-1",
    });
    const second = await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem",
      idempotencyKey: key, workflowId: "wf-1", workflowTaskId: "task-1",
    });
    expect(second.id).toBe(first.id); // idempotent hit — one run, not a duplicate
    expect(second.idempotencyKey).toBe(key);
  });

  it("rejects a key reuse with mismatched provenance (fail-closed)", async () => {
    const { createAgentRun } = await import("../store");
    const templateId = await makeTemplate();
    const key = `wf:${randomUUID()}:task:1`;
    await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-A",
      idempotencyKey: key, workflowId: "wf-1", workflowTaskId: "task-1",
    });
    let thrown: unknown = null;
    try {
      await createAgentRun({
        id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-B",
        idempotencyKey: key, workflowId: "wf-1", workflowTaskId: "task-1",
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect((thrown as Error).message).toMatch(/provenance/i);
  });

  it("distinct keys (a retry) create distinct runs", async () => {
    const { createAgentRun } = await import("../store");
    const templateId = await makeTemplate();
    const base = `wf:${randomUUID()}:task`;
    const a1 = await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem",
      idempotencyKey: `${base}:1`, workflowId: "wf-2", workflowTaskId: "task-2",
    });
    const a2 = await createAgentRun({
      id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem",
      idempotencyKey: `${base}:2`, workflowId: "wf-2", workflowTaskId: "task-2",
    });
    expect(a2.id).not.toBe(a1.id);
  });

  it("no idempotency key → plain insert, no collision", async () => {
    const { createAgentRun } = await import("../store");
    const templateId = await makeTemplate();
    const r1 = await createAgentRun({ id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem" });
    const r2 = await createAgentRun({ id: `r_${randomUUID()}`, templateId, inputParams: {}, orgId: "org-idem" });
    expect(r1.id).not.toBe(r2.id);
    expect(r1.idempotencyKey).toBeNull();
  });
});
