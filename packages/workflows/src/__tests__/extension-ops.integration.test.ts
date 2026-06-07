import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { installWorkflowTemplate } from "../extension-ops";
import { createWorkflowFromSpec, findWorkflowTemplate } from "../store";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-mkt";

const manifest = (key: string) => ({
  key,
  version: 1,
  name: "Marketplace Template",
  definition: {
    name: "Marketplace Template",
    target: { at: "2026-06-01T00:00:00Z", tz: "UTC" },
    tasks: [{ key: "a", type: "checkpoint", title: "Kickoff" }],
  },
});

beforeAll(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow_template" WHERE org_id = $1`, [ORG]);
  await c.end();
}, 60_000);

describe("workflow template marketplace ops (integration)", () => {
  it("installs a template (idempotent upsert) with re-auth", async () => {
    const r = await installWorkflowTemplate(manifest("inst"), { orgId: ORG }, { approverResolvable: () => true });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const again = await installWorkflowTemplate(manifest("inst"), { orgId: ORG });
    expect(again.ok).toBe(true); // upsert, no unique violation
  });

  it("rejects install of an invalid manifest (fail-closed)", async () => {
    const r = await installWorkflowTemplate({ key: "bad", version: 1, name: "B", definition: { name: "B", tasks: [] } }, { orgId: ORG });
    expect(r.ok).toBe(false);
  });

  it("re-authorizes referenced agents in the consuming org and rejects when an agent is unavailable", async () => {
    const agentManifest = {
      key: "needs-agent",
      version: 1,
      name: "Needs Agent",
      definition: {
        name: "Needs Agent",
        target: { at: "2026-06-01T00:00:00Z", tz: "UTC" },
        tasks: [{ key: "a", type: "agent_task", title: "A", agentRef: { package: "@cinatra-ai/asset-blog" } }],
      },
    };
    const denied = await installWorkflowTemplate(agentManifest, { orgId: ORG }, { agentExists: () => false });
    expect(denied.ok).toBe(false);
    const allowed = await installWorkflowTemplate(agentManifest, { orgId: ORG }, { agentExists: () => true });
    expect(allowed.ok).toBe(true);
  });

  // Workflow uninstall routes through extensionRegistry.uninstall("workflow", ...)
  // so the dispatcher's syncCanonicalManifestTransition owns the canonical
  // archive. The dispatcher path is exercised by extensions' registry tests.
});
