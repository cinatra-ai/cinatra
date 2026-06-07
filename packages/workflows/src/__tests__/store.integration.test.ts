import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
// Test-only host import: the canonical DDL builder. Applying it to the isolated
// schema brings the release-workflows tables into existence when a worktree
// schema is older than the current DDL. Idempotent (CREATE … IF NOT EXISTS)
// and matches the production fresh-schema path.
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import {
  createWorkflowFromSpec,
  readWorkflow,
  reconstructSpec,
  createWorkflowTemplate,
  readWorkflowTemplate,
  updateWorkflowStatusCas,
} from "../store";
import { nonAgentFixture, agentFixture, approvalFixture } from "./fixtures";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-itest";

const V6_TABLES = [
  "workflow_template",
  "workflow",
  "workflow_task",
  "workflow_dependency",
  "workflow_gate",
  "workflow_event",
  "workflow_task_attempt",
  "workflow_artifact",
  "workflow_approval",
];

beforeAll(async () => {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await client.connect();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await client.query(q.text);
  // Greenfield convergence (dev/test schema only): drop the stale global
  // (key,version) unique left by earlier branch runs — superseded by the
  // per-org (org_id,key,version) unique.
  await client.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  // Idempotent reruns: clear this test org's rows (workflow delete cascades
  // tasks/deps/gates/events/attempts/artifacts/approvals via workflow_id).
  await client.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await client.query(`DELETE FROM "${SCHEMA}"."workflow_template" WHERE org_id = $1`, [ORG]);
  await client.end();
}, 60_000);

describe("fresh-schema", () => {
  it("all 9 workflow tables exist after applying the canonical DDL", async () => {
    const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
    await client.connect();
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2)`,
      [SCHEMA, V6_TABLES],
    );
    await client.end();
    expect(new Set(rows.map((r) => r.table_name))).toEqual(new Set(V6_TABLES));
  });

  it("the GIN approver index + key unique indexes exist", async () => {
    const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
    await client.connect();
    const { rows } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename LIKE 'workflow%'`,
      [SCHEMA],
    );
    await client.end();
    const names = new Set(rows.map((r) => r.indexname));
    expect(names.has("workflow_approval_resolved_approvers_gin")).toBe(true);
    expect(names.has("workflow_task_attempt_idempotency_key_uniq")).toBe(true);
    expect(names.has("workflow_template_org_key_version_uniq")).toBe(true);
  });
});

describe("store CRUD round-trip", () => {
  it("creates a workflow from a non-agent spec and round-trips it", async () => {
    const { workflowId } = await createWorkflowFromSpec({
      spec: nonAgentFixture,
      name: nonAgentFixture.name,
      product: nonAgentFixture.product,
      orgId: ORG,
      ownerLevel: "organization",
      ownerId: ORG,
      createdBy: "user-itest",
    });
    const read = await readWorkflow(workflowId);
    expect(read).not.toBeNull();
    expect(read!.tasks).toHaveLength(nonAgentFixture.tasks.length);
    // dependency edges persisted (freeze<-kickoff, hold<-freeze, announce<-hold)
    expect(read!.dependencies).toHaveLength(3);
    // planned dates were resolved + stored
    const announce = read!.tasks.find((t) => t.key === "announce")!;
    expect(announce.dueAtUtc).not.toBeNull();

    const spec = await reconstructSpec(workflowId);
    expect(spec!.tasks.map((t) => t.key).sort()).toEqual(
      nonAgentFixture.tasks.map((t) => t.key).sort(),
    );
  });

  it("persists an agent_task's agentRef and an approval row", async () => {
    const agentWf = await createWorkflowFromSpec({ spec: agentFixture, name: agentFixture.name, orgId: ORG });
    const agentRead = await readWorkflow(agentWf.workflowId);
    const blog = agentRead!.tasks.find((t) => t.key === "blog")!;
    expect(blog.agentPackage).toBe("@cinatra-ai/asset-blog");
    expect((blog.agentRef as { package?: string }).package).toBe("@cinatra-ai/asset-blog");

    const approvalWf = await createWorkflowFromSpec({ spec: approvalFixture, name: approvalFixture.name, orgId: ORG });
    const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
    await client.connect();
    const { rows } = await client.query(
      `SELECT status, required_scope FROM "${SCHEMA}"."workflow_approval" WHERE workflow_id = $1`,
      [approvalWf.workflowId],
    );
    await client.end();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
  });

  it("CAS-updates workflow status and rejects a stale lock_version", async () => {
    const { workflowId } = await createWorkflowFromSpec({ spec: nonAgentFixture, name: "CAS test", orgId: ORG });
    // draft -> active with the correct lock_version (0)
    expect(await updateWorkflowStatusCas(workflowId, "active", 0)).toBe(true);
    // a second attempt with the stale lock_version fails (now 1)
    expect(await updateWorkflowStatusCas(workflowId, "paused", 0)).toBe(false);
    // correct lock_version succeeds
    expect(await updateWorkflowStatusCas(workflowId, "paused", 1)).toBe(true);
  });

  it("creates + reads a workflow template", async () => {
    const tmpl = await createWorkflowTemplate({
      key: "major-product-release",
      version: 1,
      name: "Major Product Release",
      definition: agentFixture,
      orgId: ORG,
      ownerLevel: "organization",
      ownerId: ORG,
    });
    // extension_lifecycle_status is no longer stored on workflow templates;
    // canonical status lives in installed_extension.
    const read = await readWorkflowTemplate(tmpl.id);
    expect(read!.key).toBe("major-product-release");
  });
});
