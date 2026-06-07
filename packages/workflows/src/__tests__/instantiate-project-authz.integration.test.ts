import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { createWorkflowPrimitiveHandlers } from "../mcp/handlers";
import { createWorkflowTemplate } from "../store";
import type { WorkflowSpec } from "../spec/schema";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-instauthz";
const USER = "user-instauthz";

// Stub the host's write-grant gate: throws for the "denied" project, ok otherwise.
const handlers = createWorkflowPrimitiveHandlers({
  approverResolvable: () => true,
  assertProjectWriteAccess: async (_actor, projectId) => {
    if (projectId === "proj-denied") throw new Error("Requires write; have read");
  },
});
const req = (input: unknown) => ({
  primitiveName: "workflow_template_instantiate",
  input: input as Record<string, unknown>,
  actor: { orgId: ORG, userId: USER },
  mode: "agentic" as const,
});

const definition: WorkflowSpec = {
  name: "Authz WF",
  target: { at: "2026-06-01T00:00:00Z", tz: "UTC" },
  tasks: [{ key: "a", type: "checkpoint", title: "Kickoff" }],
};

let templateId: string;

async function client() {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  return c;
}

beforeAll(async () => {
  const c = await client();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow_template" WHERE org_id = $1`, [ORG]);
  await c.end();
  const row = await createWorkflowTemplate({ key: "authz", version: 1, name: "Authz", definition, orgId: ORG, ownerLevel: "organization", ownerId: ORG, createdBy: USER });
  templateId = row.id;
}, 60_000);

describe("workflow_template_instantiate projectId authz (PORT-08)", () => {
  it("DENY: no write grant on the projectId → FORBIDDEN, no workflow row created", async () => {
    const res = (await handlers.workflow_template_instantiate(req({ templateId, projectId: "proj-denied" }))) as Record<string, unknown>;
    expect(res.code).toBe("FORBIDDEN");
    expect(res.workflowId).toBeUndefined();
    const c = await client();
    const n = await c.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."workflow" WHERE org_id=$1 AND project_id=$2`, [ORG, "proj-denied"]);
    expect(n.rows[0].n).toBe(0); // fail-closed BEFORE any DB write
    await c.end();
  });

  it("ALLOW: with write access, persists workflow.project_id", async () => {
    const res = (await handlers.workflow_template_instantiate(req({ templateId, projectId: "proj-ok" }))) as Record<string, unknown>;
    expect(res.workflowId).toBeTruthy();
    const c = await client();
    const row = await c.query(`SELECT project_id FROM "${SCHEMA}"."workflow" WHERE id=$1`, [res.workflowId]);
    expect(row.rows[0].project_id).toBe("proj-ok");
    await c.end();
  });

  it("no projectId → no authz call, instantiates with NULL project_id", async () => {
    const res = (await handlers.workflow_template_instantiate(req({ templateId }))) as Record<string, unknown>;
    expect(res.workflowId).toBeTruthy();
    const c = await client();
    const row = await c.query(`SELECT project_id FROM "${SCHEMA}"."workflow" WHERE id=$1`, [res.workflowId]);
    expect(row.rows[0].project_id).toBeNull();
    await c.end();
  });
});
