/**
 * cinatra#3092 — the core-tree test agent whose run writes one dashboard
 * (tests/fixtures/dashboard-producer-agent). It has a start step, one
 * passthrough call to `dashboards_create` and an end step, and no model.
 *
 * The test pins: the published marker matches the OAS bytes (the WayFlow
 * loader refuses a mismatch); the host's OAS validation finds nothing; the
 * flow makes exactly one passthrough call, to `dashboards_create`, with the run
 * id bridged from the dispatcher's `cinatra_run_id` and no identity of its own;
 * and the call's input parses against the tool's own input schema.
 *
 *   npx vitest run src/__tests__/dashboard-producer-fixture-3092.test.ts
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validateOasAgentJson } from "../../packages/agents/src/validate-agent-json";
import { dashboardsCreateSchema } from "../../packages/dashboards/src/mcp/schemas";

const ROOT = join(
  __dirname,
  "..",
  "..",
  "tests",
  "fixtures",
  "dashboard-producer-agent",
  "cinatra-dashboard-fixture",
  "run-writes-dashboard",
);
const PACKAGE_NAME = "@cinatra-dashboard-fixture/run-writes-dashboard";

const oasBytes = readFileSync(join(ROOT, "cinatra", "oas.json"));
const oas = JSON.parse(oasBytes.toString("utf8")) as Record<string, unknown>;
const marker = JSON.parse(readFileSync(join(ROOT, ".cinatra-published.json"), "utf8")) as Record<
  string,
  unknown
>;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as Record<string, unknown>;

type Node = Record<string, unknown>;
const components = oas["$referenced_components"] as Record<string, Node>;
const nodesOfType = (type: string) =>
  Object.values(components).filter((node) => node.component_type === type);

describe("dashboard producer fixture (cinatra#3092)", () => {
  it("is a private package whose marker matches the OAS bytes", () => {
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(pkg.private).toBe(true);
    expect(typeof pkg.license).toBe("string");
    expect(marker.packageName).toBe(PACKAGE_NAME);
    expect(marker.oasSha256).toBe(createHash("sha256").update(oasBytes).digest("hex"));
  });

  it("passes the host's OAS validation", () => {
    expect(validateOasAgentJson(oas)).toEqual([]);
  });

  it("is a start step, one passthrough call and an end step, with no model", () => {
    expect(Object.values(components).map((node) => node.component_type).sort()).toEqual([
      "ApiNode",
      "EndNode",
      "StartNode",
    ]);
    const [api] = nodesOfType("ApiNode");
    expect(api.url).toBe("{{CINATRA_BASE_URL}}/api/agents/passthrough");
    expect(api.http_method).toBe("POST");
  });

  it("calls dashboards_create as the run, with no identity of its own", () => {
    const [api] = nodesOfType("ApiNode");
    const data = api.data as Record<string, unknown>;
    expect(data.tool).toBe("dashboards_create");
    expect(data.agent_run_id).toBe("{{ agent_run_id }}");
    const input = data.input as Record<string, unknown>;
    for (const key of ["orgId", "organizationId", "userId", "runId", "orgWriteAuthority"]) {
      expect(input).not.toHaveProperty(key);
    }
    expect(input.ownerLevel).toBe("user");
    expect(input.ownerId).toBe("me");
    // The run id the ApiNode sends is the dispatcher's own, bridged from the start.
    const edges = oas["data_flow_connections"] as Array<Record<string, unknown>>;
    const runEdge = edges.find((edge) => edge.destination_input === "agent_run_id");
    expect(runEdge?.source_output).toBe("cinatra_run_id");
    const start = nodesOfType("StartNode")[0];
    expect(
      ((start.metadata as Node).cinatra as { hidden: string[] }).hidden,
    ).toContain("cinatra_run_id");
  });

  it("sends an input the tool's own schema accepts", () => {
    const [api] = nodesOfType("ApiNode");
    const input = (api.data as Record<string, unknown>).input as Record<string, unknown>;
    const parsed = dashboardsCreateSchema.safeParse({ ...input, name: "Run dashboard" });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it("ends with the id of the dashboard the run wrote", () => {
    const [end] = nodesOfType("EndNode");
    expect((end.outputs as Array<{ title: string }>).map((o) => o.title)).toEqual(["dashboardId"]);
    expect((oas.outputs as Array<{ title: string }>).map((o) => o.title)).toEqual(["dashboardId"]);
  });
});
