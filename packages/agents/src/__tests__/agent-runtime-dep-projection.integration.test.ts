// cinatra#1056 — LIVE real-Postgres proof of the runtime-dependency-gate
// persistence surface.
//
// The install-time projection and the boot-time backfill both write the two
// runtime-gate columns the run layer reads — `connector_dependencies` (widened
// to carry each edge's `requirement`) and `agent_dependencies` — and both read
// them back through the public store. Unit suites mock the store; this suite
// exercises the REAL store functions against a real Postgres schema so the
// widened object-valued `connector_dependencies` union is proven to survive a
// genuine INSERT/SELECT round-trip (it persists as JSON text, so a naive
// column-type assumption could silently drop the `requirement`), and the two
// store functions the backfill's default deps call —
// `readAllAgentTemplatesWithPackageName` (its `listTemplates` source) and
// `updateAgentTemplate` (its `updateTemplateDeps` sink) — are proven on the
// real column.
//
// Skips when no DB is configured (same pattern as store-auth-policy.integration).
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string" &&
  dbUrl.length > 0 &&
  !dbUrl.includes("unused:unused@localhost:5432/unused");

// A required + an optional connector edge, object-valued (the cinatra#1056
// widening). The `requirement` is the field a plain-string legacy column could
// not carry — asserting it survives the round-trip is the point.
const CONNECTOR_MAP = {
  "@cinatra-ai/wordpress-mcp-connector": { range: "^1.0.0", requirement: "required" as const },
  "@cinatra-ai/apollo-connector": { range: "^2.0.0", requirement: "optional" as const },
};
const AGENT_MAP = { "@cinatra-ai/sub-agent": "2.3.4" };

const baseSeed = (id: string, packageName: string) => ({
  id,
  name: "runtime-dep-rt",
  sourceNl: "x",
  compiledPlan: [],
  inputSchema: {},
  approvalPolicy: { steps: [] },
  packageName,
  packageVersion: "1.0.0",
});

describe.skipIf(!hasDb)("cinatra#1056 runtime-dep maps — real Postgres round-trip", () => {
  it("createAgentTemplate persists object-valued connector_dependencies (+requirement) + agent_dependencies; readAgentTemplateById round-trips them exactly", async () => {
    const { createAgentTemplate, readAgentTemplateById } = await import("../store");
    const id = `t_${randomUUID()}`;
    const packageName = `@cinatra-ai/rt-${randomUUID().slice(0, 8)}`;
    await createAgentTemplate({
      ...baseSeed(id, packageName),
      connectorDependencies: CONNECTOR_MAP,
      agentDependencies: AGENT_MAP,
    });
    const read = await readAgentTemplateById(id);
    expect(read).not.toBeNull();
    // The `requirement` on each connector edge survives the JSON-text round-trip.
    expect(read!.connectorDependencies).toEqual(CONNECTOR_MAP);
    expect(read!.agentDependencies).toEqual(AGENT_MAP);
  });

  it("readAllAgentTemplatesWithPackageName (the backfill listTemplates source) returns the template carrying both maps", async () => {
    const { createAgentTemplate, readAllAgentTemplatesWithPackageName } = await import("../store");
    const id = `t_${randomUUID()}`;
    const packageName = `@cinatra-ai/rt-${randomUUID().slice(0, 8)}`;
    await createAgentTemplate({
      ...baseSeed(id, packageName),
      connectorDependencies: CONNECTOR_MAP,
      agentDependencies: AGENT_MAP,
    });
    const rows = await readAllAgentTemplatesWithPackageName();
    const mine = rows.find((r) => r.id === id);
    expect(mine).toBeDefined();
    expect(mine!.packageName).toBe(packageName);
    expect(mine!.connectorDependencies).toEqual(CONNECTOR_MAP);
    expect(mine!.agentDependencies).toEqual(AGENT_MAP);
  });

  it("updateAgentTemplate (the backfill updateTemplateDeps sink) projects the maps onto a template installed WITHOUT them", async () => {
    const { createAgentTemplate, updateAgentTemplate, readAgentTemplateById } = await import(
      "../store"
    );
    const id = `t_${randomUUID()}`;
    const packageName = `@cinatra-ai/rt-${randomUUID().slice(0, 8)}`;
    // Pre-projection install: no runtime-dep columns.
    await createAgentTemplate(baseSeed(id, packageName));
    const before = await readAgentTemplateById(id);
    expect(before!.connectorDependencies).toEqual({});
    expect(before!.agentDependencies).toEqual({});
    // The backfill re-projects the canonical edges onto the columns.
    await updateAgentTemplate(id, {
      connectorDependencies: CONNECTOR_MAP,
      agentDependencies: AGENT_MAP,
    });
    const after = await readAgentTemplateById(id);
    expect(after!.connectorDependencies).toEqual(CONNECTOR_MAP);
    expect(after!.agentDependencies).toEqual(AGENT_MAP);
  });
});
