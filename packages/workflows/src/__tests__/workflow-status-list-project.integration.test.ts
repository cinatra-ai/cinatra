import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { createWorkflowFromSpec, listWorkflows } from "../store";
import type { WorkflowSpec } from "../spec/schema";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-port10";
const USER = "test-user-port10";

const spec: WorkflowSpec = {
  name: "Port10 WF",
  target: { at: "2026-06-01T00:00:00Z", tz: "UTC" },
  tasks: [{ key: "a", type: "checkpoint", title: "Kickoff" }],
};

beforeAll(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await c.end();
}, 60_000);

describe("listWorkflows projectId filter (PORT-10)", () => {
  it("filters by projectId when supplied; returns all org workflows when omitted", async () => {
    await createWorkflowFromSpec({ spec, name: "P1", orgId: ORG, ownerLevel: "user", ownerId: USER, createdBy: USER, projectId: "proj-1" });
    await createWorkflowFromSpec({ spec, name: "P2", orgId: ORG, ownerLevel: "user", ownerId: USER, createdBy: USER, projectId: "proj-2" });
    await createWorkflowFromSpec({ spec, name: "NoProj", orgId: ORG, ownerLevel: "user", ownerId: USER, createdBy: USER });

    const proj1 = await listWorkflows({ orgId: ORG, projectId: "proj-1" });
    expect(proj1).toHaveLength(1);
    expect(proj1[0].name).toBe("P1");

    const all = await listWorkflows({ orgId: ORG });
    expect(all.length).toBeGreaterThanOrEqual(3); // regression: filter omitted → all visible

    const none = await listWorkflows({ orgId: ORG, projectId: "proj-absent" });
    expect(none).toHaveLength(0);
  });
});
