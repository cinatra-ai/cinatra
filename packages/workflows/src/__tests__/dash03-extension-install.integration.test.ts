import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { installWorkflowExtension, WorkflowExtensionError } from "../extension-ops";
import { materializeExtensionInstanceForProject } from "@cinatra-ai/dashboards/extension-materialization";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-dash03";
const USER = "test-user-dash03";
const PKG = "@cinatra-ai/dash03-stub-workflow";
const dashActor = { userId: USER, organizationId: ORG, teamIds: [] as string[], orgRole: "admin" as const, teamRoles: {} };

const STUB_BPMN = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:cinatra="http://cinatra.ai/schema/bpmn/profile-1.0" id="d">
  <bpmn:process id="dash03-stub" name="Dash03 Stub" isExecutable="false">
    <bpmn:documentation>Stub workflow for DASH-03 integration test.</bpmn:documentation>
    <bpmn:extensionElements><cinatra:workflowMeta name="Dash03 Stub Def" /></bpmn:extensionElements>
    <bpmn:startEvent id="s"/>
    <bpmn:manualTask id="m" name="Do it"/>
    <bpmn:endEvent id="e"/>
    <bpmn:sequenceFlow id="f0" sourceRef="s" targetRef="m"/>
    <bpmn:sequenceFlow id="f1" sourceRef="m" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

const STUB_DASHBOARD = JSON.stringify({
  apiVersion: "v1.2",
  scopeLevel: "project",
  // object-list requires config.typeId (per-kind install validation).
  portlets: [{ instanceId: "list", kind: "object-list", version: "1.0.0", slot: "fixed", config: { typeId: "blog-post" } }],
});

let extRoot: string;

async function dbClient() {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  return c;
}

beforeAll(async () => {
  const c = await dbClient();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.query(`DELETE FROM "${SCHEMA}"."dashboards" WHERE extension_id = $1`, [PKG]);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow_template" WHERE org_id = $1`, [ORG]);
  await c.end();

  extRoot = await mkdtemp(join(tmpdir(), "dash03-ext-"));
  const pkgDir = join(extRoot, "cinatra-ai", "dash03-stub-workflow");
  await mkdir(join(pkgDir, "cinatra"), { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: PKG, version: "1.0.0", private: true, cinatra: { apiVersion: "cinatra.ai/v1", kind: "workflow", workflowVersion: 1 } }),
    "utf8",
  );
  await writeFile(join(pkgDir, "cinatra", "workflow.bpmn"), STUB_BPMN, "utf8");
  await writeFile(join(pkgDir, "cinatra", "dashboard.json"), STUB_DASHBOARD, "utf8");
}, 60_000);

afterAll(async () => {
  if (extRoot) await rm(extRoot, { recursive: true, force: true });
});

describe("workflow extension adapter (DASH-03 integration)", () => {
  it("fails closed with MISSING_ORG_CONTEXT when orgId is absent", async () => {
    await expect(installWorkflowExtension({ packageName: PKG }, { userId: USER }, {}, { extensionsRoot: extRoot })).rejects.toMatchObject({
      code: "MISSING_ORG_CONTEXT",
    });
  });

  it("installs the workflow template AND materializes the dashboard template (idempotent)", async () => {
    const r1 = await installWorkflowExtension({ packageName: PKG }, { userId: USER, orgId: ORG }, {}, { extensionsRoot: extRoot });
    expect(r1.templateId).toBeTruthy();
    expect(r1.dashboardMaterialized).toBe(true);
    // idempotent re-install
    const r2 = await installWorkflowExtension({ packageName: PKG }, { userId: USER, orgId: ORG }, {}, { extensionsRoot: extRoot });
    expect(r2.dashboardMaterialized).toBe(true);

    const c = await dbClient();
    const tmpl = await c.query(
      `SELECT id, is_template, template_scope, project_id, status FROM "${SCHEMA}"."dashboards" WHERE extension_id=$1 AND is_template=true`,
      [PKG],
    );
    expect(tmpl.rows.length).toBe(1); // exactly one template (idempotent)
    expect(tmpl.rows[0].template_scope).toBe("project");
    expect(tmpl.rows[0].project_id).toBeNull();
    expect(tmpl.rows[0].status).toBe("published");
    await c.end();
  });

  it("materializes a per-project instance (idempotent) and archive/restore flips status", async () => {
    const a = await materializeExtensionInstanceForProject(undefined, { extensionId: PKG, organizationId: ORG, projectId: "proj-1", actor: dashActor });
    const b = await materializeExtensionInstanceForProject(undefined, { extensionId: PKG, organizationId: ORG, projectId: "proj-1", actor: dashActor });
    expect(a.id).toBe(b.id); // idempotent
    expect(a.isTemplate).toBe(false);
    expect(a.projectId).toBe("proj-1");

    const c = await dbClient();
    const beforeArchive = await c.query(`SELECT count(*)::int AS n FROM "${SCHEMA}"."dashboards" WHERE extension_id=$1`, [PKG]);
    expect(beforeArchive.rows[0].n).toBe(2); // template + 1 instance

    // archive + restore via the adapter
    const { archiveWorkflowExtensionDashboards, restoreWorkflowExtensionDashboards } = await import("../extension-ops");
    const archived = await archiveWorkflowExtensionDashboards({ packageName: PKG }, { userId: USER, orgId: ORG });
    expect(archived).toBe(2);
    const archStatus = await c.query(`SELECT DISTINCT status FROM "${SCHEMA}"."dashboards" WHERE extension_id=$1`, [PKG]);
    expect(archStatus.rows.map((r) => r.status)).toEqual(["archived"]);

    const restored = await restoreWorkflowExtensionDashboards({ packageName: PKG }, { userId: USER, orgId: ORG });
    expect(restored).toBe(2);
    const restStatus = await c.query(`SELECT DISTINCT status FROM "${SCHEMA}"."dashboards" WHERE extension_id=$1`, [PKG]);
    expect(restStatus.rows.map((r) => r.status)).toEqual(["published"]);
    await c.end();
  });

  it("WorkflowExtensionError is thrown (not a raw Error) for missing context", async () => {
    const err = await installWorkflowExtension({ packageName: PKG }, {}, {}, { extensionsRoot: extRoot }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkflowExtensionError);
  });
});
