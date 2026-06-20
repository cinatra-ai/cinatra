import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { createWorkflowPrimitiveHandlers } from "../mcp/handlers";
import { createWorkflowTemplate, listWorkflowTemplates } from "../store";
import { RELEASE_TEMPLATE_FIXTURE, agentFixture, nonAgentFixture } from "./fixtures";

// Test-owned idempotent seed of the release-template FIXTURE (the host-side
// seed module is retired, cinatra#151 Stage 6 — the extension-owned template
// ships via the major-release-workflow extension's bpmn install path).
const FIXTURE_TEMPLATE_KEY = "major-product-release";
const FIXTURE_TEMPLATE_VERSION = 1;
async function seedReleaseTemplateFixture(input: {
  orgId: string;
}): Promise<{ created: boolean; templateId: string }> {
  const existing = (await listWorkflowTemplates({ orgId: input.orgId })).find(
    (t) => t.key === FIXTURE_TEMPLATE_KEY && t.version === FIXTURE_TEMPLATE_VERSION,
  );
  if (existing) return { created: false, templateId: existing.id };
  const tmpl = await createWorkflowTemplate({
    key: FIXTURE_TEMPLATE_KEY,
    version: FIXTURE_TEMPLATE_VERSION,
    name: "Major Product Release",
    description: "AI-assisted multi-week product launch: content drafts, legal sign-off, go/no-go, announce.",
    definition: RELEASE_TEMPLATE_FIXTURE,
    orgId: input.orgId,
    ownerLevel: "organization",
    ownerId: input.orgId,
    createdBy: null,
  });
  return { created: true, templateId: tmpl.id };
}

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-handlers";
const USER = "user-handlers";

const handlers = createWorkflowPrimitiveHandlers({
  approverResolvable: () => true,
});
const req = (input: unknown) => ({
  primitiveName: "x",
  input: input as Record<string, unknown>,
  actor: { orgId: ORG, userId: USER },
  mode: "agentic",
});

beforeAll(async () => {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await client.connect();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await client.query(q.text);
  // Greenfield convergence: drop the stale global (key,version) unique.
  await client.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await client.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await client.query(`DELETE FROM "${SCHEMA}"."workflow_template" WHERE org_id = $1`, [ORG]);
  await client.end();
}, 60_000);

describe("chat MCP handlers (integration)", () => {
  it("creates a draft, returns a workflow handoff, and reads it back", async () => {
    const created = (await handlers.workflow_draft_create(req({ spec: nonAgentFixture }))) as {
      workflowId: string;
      deepLink: string;
      renderHint: string;
    };
    expect(created.workflowId).toBeTruthy();
    expect(created.deepLink).toBe(`/workflows/${created.workflowId}`);
    expect(created.renderHint).toBe("workflow");

    const got = (await handlers.workflow_draft_get(req({ workflowId: created.workflowId }))) as {
      workflow: { id: string; status: string };
      tasks: unknown[];
      timeline: Record<string, unknown>;
    };
    expect(got.workflow.status).toBe("draft");
    expect(got.tasks).toHaveLength(nonAgentFixture.tasks.length);
    expect(Object.keys(got.timeline).length).toBe(nonAgentFixture.tasks.length);
  });

  it("updates a draft with CAS and rejects a stale lock_version", async () => {
    const created = (await handlers.workflow_draft_create(req({ spec: nonAgentFixture }))) as {
      workflowId: string;
    };
    const updated = (await handlers.workflow_draft_update(
      req({ workflowId: created.workflowId, spec: agentFixture, expectedLockVersion: 0 }),
    )) as { lockVersion?: number; error?: string };
    expect(updated.error).toBeUndefined();
    expect(updated.lockVersion).toBe(1);

    const stale = (await handlers.workflow_draft_update(
      req({ workflowId: created.workflowId, spec: agentFixture, expectedLockVersion: 0 }),
    )) as { error?: string; code?: string };
    expect(stale.code).toBe("stale");
  });

  it("instantiates a template into a draft (snapshot + provenance + handoff)", async () => {
    const tmpl = await createWorkflowTemplate({
      key: "handlers-itest-template",
      version: 1,
      name: "Handlers ITest Template",
      definition: agentFixture,
      orgId: ORG,
      ownerLevel: "organization",
      ownerId: ORG,
    });
    const instantiated = (await handlers.workflow_template_instantiate(
      req({ templateId: tmpl.id, name: "From Template" }),
    )) as unknown as { workflowId: string; sourceTemplateId: string; sourceTemplateVersion: number };
    expect(instantiated.workflowId).toBeTruthy();
    expect(instantiated.sourceTemplateId).toBe(tmpl.id);
    expect(instantiated.sourceTemplateVersion).toBe(1);
  });

  it("lists templates + drafts scoped to the org", async () => {
    const templates = (await handlers.workflow_template_list(req({}))) as {
      templates: { key: string }[];
    };
    expect(templates.templates.some((t) => t.key === "handlers-itest-template")).toBe(true);
    const drafts = (await handlers.workflow_draft_list(req({}))) as { workflows: unknown[] };
    expect(drafts.workflows.length).toBeGreaterThan(0);
  });

  it("seeds the Major Product Release template and round-trips instantiate → preview", async () => {
    const first = await seedReleaseTemplateFixture({ orgId: ORG });
    expect(first.created).toBe(true);
    const again = await seedReleaseTemplateFixture({ orgId: ORG }); // idempotent
    expect(again.created).toBe(false);

    const list = (await handlers.workflow_template_list(req({}))) as {
      templates: { id: string; key: string }[];
    };
    const t = list.templates.find((x) => x.key === "major-product-release");
    expect(t).toBeTruthy();

    const inst = (await handlers.workflow_template_instantiate(
      req({ templateId: t!.id, inputs: { product: "Acme 9" }, targetAt: "2026-12-01T00:00:00Z", targetTz: "UTC" }),
    )) as { workflowId: string; error?: string };
    expect(inst.error).toBeUndefined();
    expect(inst.workflowId).toBeTruthy();

    const preview = (await handlers.workflow_preview(req({ workflowId: inst.workflowId }))) as {
      validation: { draftValid: boolean; errors: unknown[] };
      timeline: Record<string, unknown>;
    };
    expect(preview.validation.draftValid, JSON.stringify(preview.validation.errors)).toBe(true);
    expect(Object.keys(preview.timeline)).toHaveLength(6);

    // cascade preview — moving the release date shifts unpinned relative tasks
    const cascade = (await handlers.workflow_cascade_preview(
      req({ workflowId: inst.workflowId, targetAt: "2026-12-15T00:00:00Z" }),
    )) as { cascade: { taskKey: string; oldDueAtUtc: string; newDueAtUtc: string }[] };
    expect(cascade.cascade.length).toBeGreaterThan(0);
    expect(cascade.cascade.every((c) => c.oldDueAtUtc !== c.newDueAtUtc)).toBe(true);
  });
});
