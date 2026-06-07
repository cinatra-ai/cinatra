// Regression coverage for the WIG-02 single-query window resolver. The shipped
// bug: `sql<Date>` is a TS-only assertion — drizzle returns aggregate values as
// strings, so the page-level `.toISOString()` threw and crashed the /workflows
// render. listWorkflowWindows now hand-parses to Date; these tests pin that
// contract plus the MIN/MAX aggregation and the zero-rows-vs-undated distinction.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { createWorkflowFromSpec, listWorkflowWindows } from "../store";
import type { WorkflowSpec } from "../spec/schema";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-wig02-windows";

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

async function create(name: string, taskKeys: string[]): Promise<string> {
  const spec = {
    name,
    tasks: taskKeys.map((k) => ({ key: k, type: "checkpoint", title: k })),
  } as WorkflowSpec;
  const { workflowId } = await createWorkflowFromSpec({ spec, name, orgId: ORG });
  return workflowId;
}

async function setWindow(
  workflowId: string,
  key: string,
  startUtc: string | null,
  endUtc: string | null,
): Promise<void> {
  const c = await pg();
  await c.query(
    `UPDATE "${SCHEMA}"."workflow_task" SET planned_start_utc = $3, planned_end_utc = $4 WHERE workflow_id = $1 AND key = $2`,
    [workflowId, key, startUtc, endUtc],
  );
  await c.end();
}

describe("listWorkflowWindows (WIG-02)", () => {
  it("returns real Date instances and MIN(start)/MAX(end) across the workflow's tasks", async () => {
    const dated = await create("Dated", ["early", "late"]);
    await setWindow(dated, "early", "2026-06-01T00:00:00Z", "2026-06-05T00:00:00Z");
    await setWindow(dated, "late", "2026-06-03T00:00:00Z", "2026-06-10T00:00:00Z");

    const rows = await listWorkflowWindows([dated]);
    expect(rows).toHaveLength(1);
    const row = rows[0];

    // The exact failure mode that crashed the render: aggregate strings have no
    // `.toISOString()`. The fix hand-parses to Date — assert that holds.
    expect(row.windowStartUtc).toBeInstanceOf(Date);
    expect(row.windowEndUtc).toBeInstanceOf(Date);
    expect(() => row.windowStartUtc!.toISOString()).not.toThrow();

    // MIN(planned_start) = earliest task start; MAX(planned_end) = latest task end.
    expect(row.windowStartUtc!.getTime()).toBe(Date.parse("2026-06-01T00:00:00Z"));
    expect(row.windowEndUtc!.getTime()).toBe(Date.parse("2026-06-10T00:00:00Z"));
  });

  it("returns null/null for a workflow whose tasks all lack planned dates", async () => {
    const undated = await create("Undated", ["solo"]);
    await setWindow(undated, "solo", null, null);

    const rows = await listWorkflowWindows([undated]);
    expect(rows).toHaveLength(1);
    expect(rows[0].workflowId).toBe(undated);
    expect(rows[0].windowStartUtc).toBeNull();
    expect(rows[0].windowEndUtc).toBeNull();
  });

  it("omits a workflow with zero task rows (caller applies the WIG-04 substrate fallback)", async () => {
    const empty = await create("Empty", ["ghost"]);
    const c = await pg();
    await c.query(`DELETE FROM "${SCHEMA}"."workflow_task" WHERE workflow_id = $1`, [empty]);
    await c.end();

    const rows = await listWorkflowWindows([empty]);
    expect(rows.find((r) => r.workflowId === empty)).toBeUndefined();
  });

  it("returns [] for an empty id list (early return, no query)", async () => {
    expect(await listWorkflowWindows([])).toEqual([]);
  });
});
