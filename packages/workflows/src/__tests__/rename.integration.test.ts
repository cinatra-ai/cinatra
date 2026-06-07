// Exercises the WPP-08 rename CAS: trim + non-empty validation, optimistic
// lock_version check, the narrow "only name/lockVersion/updatedAt change"
// contract, and the any-status allowance (name is metadata, not content).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  createWorkflowFromSpec,
  readWorkflow,
  renameWorkflowCas,
  updateWorkflowStatusCas,
} from "../store";
import type { WorkflowSpec } from "../spec/schema";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-wpp08-rename";

async function pg() {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  return c;
}

beforeAll(async () => {
  const c = await pg();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.end();
}, 60_000);

beforeEach(async () => {
  const c = await pg();
  await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await c.end();
});

const baseSpec: WorkflowSpec = {
  name: "Original Name",
  product: "Acme",
  target: { at: "2026-10-01T00:00:00Z", tz: "UTC" },
  tasks: [{ key: "kickoff", type: "checkpoint", title: "Kickoff" }],
} as WorkflowSpec;

async function createDraft(): Promise<string> {
  const { workflowId } = await createWorkflowFromSpec({ spec: baseSpec, name: baseSpec.name, orgId: ORG });
  return workflowId;
}

describe("renameWorkflowCas (WPP-08)", () => {
  it("renames (with trim), bumps lock_version, and touches ONLY name/lockVersion/updatedAt", async () => {
    const id = await createDraft();

    // Back-date updated_at to a known-old value so the post-rename advancement
    // assertion is deterministic (not a same-millisecond `>` flake).
    const c = await pg();
    await c.query(`UPDATE "${SCHEMA}"."workflow" SET updated_at = $2 WHERE id = $1`, [
      id,
      "2000-01-01T00:00:00Z",
    ]);
    await c.end();

    const before = (await readWorkflow(id))!.workflow;
    expect(before.lockVersion).toBe(0);

    const res = await renameWorkflowCas(id, "  Renamed Workflow  ", 0);
    expect(res).toEqual({ ok: true, lockVersion: 1 });

    const after = (await readWorkflow(id))!.workflow;
    // Name is trimmed; lock_version bumped; updated_at advanced past the backdate.
    expect(after.name).toBe("Renamed Workflow");
    expect(after.lockVersion).toBe(1);
    expect(after.updatedAt.getTime()).toBeGreaterThan(Date.parse("2000-01-01T00:00:00Z"));
    // Everything else is untouched.
    expect(after.status).toBe(before.status);
    expect(after.specVersion).toBe(before.specVersion);
    expect(after.product).toBe(before.product);
    expect(after.targetAtUtc?.toISOString()).toBe(before.targetAtUtc?.toISOString());
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString());
  });

  it("rejects a stale lock_version without writing", async () => {
    const id = await createDraft();
    const res = await renameWorkflowCas(id, "Should Not Apply", 99);
    expect(res).toEqual({ ok: false, reason: "stale" });

    const after = (await readWorkflow(id))!.workflow;
    expect(after.name).toBe("Original Name");
    expect(after.lockVersion).toBe(0);
  });

  it("rejects an empty or whitespace-only name without writing", async () => {
    const id = await createDraft();

    expect(await renameWorkflowCas(id, "", 0)).toEqual({ ok: false, reason: "invalid_name" });
    expect(await renameWorkflowCas(id, "   ", 0)).toEqual({ ok: false, reason: "invalid_name" });

    const after = (await readWorkflow(id))!.workflow;
    expect(after.name).toBe("Original Name");
    expect(after.lockVersion).toBe(0);
  });

  it("returns not_found for an unknown workflow id", async () => {
    const res = await renameWorkflowCas("00000000-0000-0000-0000-000000000000", "X", 0);
    expect(res).toEqual({ ok: false, reason: "not_found" });
  });

  it("renames on a non-draft (active) workflow — name is metadata, not content", async () => {
    const id = await createDraft();
    // draft -> active bumps lock_version to 1.
    expect(await updateWorkflowStatusCas(id, "active", 0)).toBe(true);

    const res = await renameWorkflowCas(id, "Renamed While Active", 1);
    expect(res).toEqual({ ok: true, lockVersion: 2 });

    const after = (await readWorkflow(id))!.workflow;
    expect(after.name).toBe("Renamed While Active");
    expect(after.status).toBe("active");
    expect(after.lockVersion).toBe(2);
  });
});
