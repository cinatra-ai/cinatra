import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { installWorkflowTemplate } from "../extension-ops";
import { createWorkflowFromSpec, reconstructSpec, readWorkflowTemplate } from "../store";
import { parseWorkflowBpmnSidecar } from "../bpmn";
import type { WorkflowSpec, TaskSpec } from "../spec/schema";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-bpmn-mr";
const USER = "test-user-bpmn-mr";
const MAJOR_RELEASE_ROOT = path.resolve(__dirname, "../../../../extensions/cinatra-ai/major-release-workflow");
const legacy = JSON.parse(
  readFileSync(path.resolve(__dirname, "./fixtures/major-release-workflow.legacy.json"), "utf8"),
) as { definition: WorkflowSpec };

// Compare only the structural Gantt surface: task key, type, and dependsOn edges.
function gantt(spec: WorkflowSpec): Array<{ key: string; type: string; dependsOn: TaskSpec["dependsOn"] }> {
  return spec.tasks
    .map((t) => ({ key: t.key, type: t.type, dependsOn: t.dependsOn ?? [] }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

beforeAll(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow" WHERE org_id = $1`, [ORG]);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow_template" WHERE org_id = $1`, [ORG]);
  await c.end();
}, 60_000);

describe("major-release BPMN migration (integration, BPMN-06)", () => {
  it("installs from the BPMN sidecar and instantiates the same Gantt structure as the legacy JSON", async () => {
    // 1. Parse the migrated sidecar → manifest.
    const parsed = await parseWorkflowBpmnSidecar({
      packageRoot: MAJOR_RELEASE_ROOT,
      pkgCinatra: { kind: "workflow", apiVersion: "cinatra.ai/v1", workflowVersion: 1 },
    });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;

    // 2. Install the template into the consuming org.
    const installed = await installWorkflowTemplate(parsed.manifest, { orgId: ORG, ownerLevel: "user", ownerId: USER });
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    if (!installed.ok) return;

    const tmpl = await readWorkflowTemplate(installed.templateId);
    expect(tmpl?.key).toBe("major-release");
    expect((tmpl?.definition as WorkflowSpec).tasks).toEqual(legacy.definition.tasks);

    // 3. Instantiate the BPMN-derived spec and the legacy spec; reconstruct both.
    const a = await createWorkflowFromSpec({
      spec: parsed.manifest.definition,
      name: "MR BPMN",
      product: "Acme",
      orgId: ORG,
      ownerLevel: "user",
      ownerId: USER,
      createdBy: USER,
    });
    const b = await createWorkflowFromSpec({
      spec: legacy.definition,
      name: "MR Legacy",
      product: "Acme",
      orgId: ORG,
      ownerLevel: "user",
      ownerId: USER,
      createdBy: USER,
    });

    const ganttBpmn = gantt((await reconstructSpec(a.workflowId))!);
    const ganttLegacy = gantt((await reconstructSpec(b.workflowId))!);

    // 4. Same Gantt structure (the BPMN-06 acceptance).
    expect(ganttBpmn).toEqual(ganttLegacy);
    expect(ganttBpmn.map((t) => t.key)).toEqual(["announce", "blog", "kickoff", "legal"]);
    // reconstructSpec reads dependency rows whose `outcome` defaults to "success"
    // (the same normalization applies to BOTH the BPMN and legacy instantiations —
    // ganttBpmn === ganttLegacy above is the parity proof).
    const byKey = Object.fromEntries(ganttBpmn.map((t) => [t.key, t]));
    expect(byKey.kickoff.dependsOn).toEqual([]);
    expect(byKey.blog.dependsOn).toEqual([{ taskKey: "kickoff", outcome: "success" }]);
    expect(byKey.legal.dependsOn).toEqual([{ taskKey: "blog", outcome: "success" }]);
    expect(byKey.announce.dependsOn).toEqual([{ taskKey: "legal", outcome: "success" }]);
  });
});
