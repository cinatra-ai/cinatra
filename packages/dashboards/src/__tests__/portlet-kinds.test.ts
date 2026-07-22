import { describe, it, expect, beforeAll } from "vitest";
import {
  registerCorePortletKinds,
  ANALYTICS_PORTLET_KIND,
  ANALYTICS_PORTLET_KIND_ALIAS,
  ENTITY_METADATA_PORTLET_KIND,
  ENTITY_COUNT_PORTLET_KIND,
  isAnalyticsPortletKind,
} from "../portlets/kinds";
import {
  getPortletKind,
  validatePortletConfig,
  getPortletKindDescriptor,
  isRenderOnlyPortletKind,
} from "../portlets/registry";
import { validateDashboardConfigV12, DASHBOARD_CONFIG_V12_VERSION } from "../extension/dashboard-config-v12";

const V = "1.0.0";
const vc = (kind: string, config: Record<string, unknown>, inputs?: Record<string, unknown>) =>
  validatePortletConfig(kind, V, { config, inputs });

beforeAll(() => registerCorePortletKinds());

describe("core portlet kinds", () => {
  it("registers all 7 kinds with a session scopePolicy", () => {
    for (const kind of [
      "object-list",
      "object-detail",
      "artifact-list",
      "artifact-edit-text",
      "artifact-edit-binary-prompt",
      "artifact-version-history",
      "agent-launcher",
    ]) {
      const e = getPortletKind(kind, V);
      expect(e, kind).toBeDefined();
      expect(e!.scopePolicy.scopeFrom).toBe("session");
    }
  });

  it("object-list requires config.typeId", () => {
    expect(vc("object-list", {})[0].code).toBe("port_object_list_missing_type");
    expect(vc("object-list", { typeId: "@cinatra-ai/assets:blog-project" })).toEqual([]);
  });

  it("artifact-edit-text requires refSwapPrimitive + parentObjectField", () => {
    expect(vc("artifact-edit-text", {})[0].code).toBe("port_edit_text_missing_refswap");
    expect(vc("artifact-edit-text", { refSwapPrimitive: "blog_post_update", parentObjectField: "postArtifactId" })).toEqual([]);
  });

  it("artifact-edit-binary-prompt enforces refSwapMode auto/manual + refSwapPrimitive rule", () => {
    expect(vc("artifact-edit-binary-prompt", { generationPrimitive: "g", parentObjectField: "imageArtifactId", refSwapMode: "auto" })).toEqual([]);
    // auto + refSwapPrimitive present → reject
    expect(vc("artifact-edit-binary-prompt", { generationPrimitive: "g", parentObjectField: "imageArtifactId", refSwapMode: "auto", refSwapPrimitive: "x" }).length).toBeGreaterThan(0);
    // manual without refSwapPrimitive → reject
    expect(vc("artifact-edit-binary-prompt", { generationPrimitive: "g", parentObjectField: "imageArtifactId", refSwapMode: "manual" }).length).toBeGreaterThan(0);
    expect(vc("artifact-edit-binary-prompt", { generationPrimitive: "g", parentObjectField: "imageArtifactId", refSwapMode: "manual", refSwapPrimitive: "x" })).toEqual([]);
  });

  it("agent-launcher requires an agent ref", () => {
    expect(vc("agent-launcher", {})[0].code).toBe("port_agent_launcher_missing_agent");
    expect(vc("agent-launcher", { agentPackage: "@cinatra-ai/x-agent" })).toEqual([]);
  });

  it("launcher kinds allow arbitrary input keys", () => {
    expect(getPortletKind("agent-launcher", V)!.allowsArbitraryInputs).toBe(true);
    expect(getPortletKind("object-list", V)!.allowsArbitraryInputs).toBeUndefined();
  });
});

// Entity-summary Overview building blocks (cinatra#702): render-only,
// zero-server-read presentation kinds whose config carries the pre-composed
// items the surface fetched.
describe("entity-summary portlet kinds (cinatra#702)", () => {
  for (const kind of [ENTITY_METADATA_PORTLET_KIND, ENTITY_COUNT_PORTLET_KIND]) {
    it(`${kind} registers render-only with a no-read session policy`, () => {
      const e = getPortletKind(kind, V);
      expect(e, kind).toBeDefined();
      expect(e!.scopePolicy.scopeFrom).toBe("session");
      // No server read → resource "none", no op, no wiring.
      expect(e!.scopePolicy.resource).toBe("none");
      expect(e!.scopePolicy.op).toBeUndefined();
      expect(e!.inputKeys).toEqual([]);
      expect(e!.outputKeys).toEqual([]);
      expect(e!.renderOnly).toBe(true);
      expect(isRenderOnlyPortletKind(kind, V)).toBe(true);
    });

    it(`${kind} accepts a well-formed items config`, () => {
      expect(vc(kind, { items: [{ label: "Name", value: "Platform" }] })).toEqual([]);
      // finite number values (counts) and an optional title are allowed.
      expect(vc(kind, { title: "Team", items: [{ label: "Members", value: 5 }] })).toEqual([]);
    });

    it(`${kind} fails closed on a missing/empty/malformed items config`, () => {
      expect(vc(kind, {}).length).toBeGreaterThan(0);
      expect(vc(kind, { items: [] }).length).toBeGreaterThan(0);
      // non-array items.
      expect(vc(kind, { items: "nope" }).length).toBeGreaterThan(0);
      // blank label.
      expect(vc(kind, { items: [{ label: "", value: "x" }] }).length).toBeGreaterThan(0);
      // non-string / non-finite value.
      expect(vc(kind, { items: [{ label: "L", value: {} }] }).length).toBeGreaterThan(0);
      expect(vc(kind, { items: [{ label: "L", value: Number.POSITIVE_INFINITY }] }).length).toBeGreaterThan(0);
      // non-string title.
      expect(vc(kind, { title: 7, items: [{ label: "L", value: "x" }] }).length).toBeGreaterThan(0);
    });
  }

  it("normal kinds are NOT render-only", () => {
    expect(isRenderOnlyPortletKind("object-detail", V)).toBe(false);
    expect(isRenderOnlyPortletKind(ANALYTICS_PORTLET_KIND, V)).toBe(false);
  });
});

// The keystone analytics portlet (cinatra#325) wraps a whole drizzle-cube
// dashboard at config.dashboard.
describe("analytics portlet kind (cinatra#325)", () => {
  const goodDashboard = {
    portlets: [
      {
        id: "p",
        title: "P",
        w: 6,
        h: 8,
        x: 0,
        y: 0,
        analysisConfig: {
          version: 1,
          analysisType: "query",
          query: { measures: ["agent_runs.count"], dimensions: ["agent_runs.agent_name"] },
        },
      },
    ],
    layoutMode: "grid",
    grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
  };

  it("registers `analytics` and the `cube-dashboard` alias with a dashboard-scoped session policy", () => {
    for (const kind of [ANALYTICS_PORTLET_KIND, ANALYTICS_PORTLET_KIND_ALIAS]) {
      const e = getPortletKind(kind, V);
      expect(e, kind).toBeDefined();
      expect(e!.scopePolicy.scopeFrom).toBe("session");
      expect(e!.scopePolicy.resource).toBe("dashboard");
      // self-contained: no op, no inputs/outputs.
      expect(e!.scopePolicy.op).toBeUndefined();
      expect(e!.inputKeys).toEqual([]);
      expect(e!.outputKeys).toEqual([]);
    }
  });

  it("isAnalyticsPortletKind recognizes both names and rejects others", () => {
    expect(isAnalyticsPortletKind("analytics")).toBe(true);
    expect(isAnalyticsPortletKind("cube-dashboard")).toBe(true);
    expect(isAnalyticsPortletKind("object-list")).toBe(false);
  });

  it("validateConfig requires config.dashboard and rejects a missing/malformed embedded config", () => {
    expect(vc(ANALYTICS_PORTLET_KIND, {})[0].code).toBe("port_analytics_missing_dashboard");
    expect(vc(ANALYTICS_PORTLET_KIND, { dashboard: 42 })[0].code).toBe("port_analytics_missing_dashboard");
    // present-but-structurally-invalid (a portlet with neither analysisConfig nor query) → invalid.
    expect(
      vc(ANALYTICS_PORTLET_KIND, {
        dashboard: { portlets: [{ id: "p", title: "P", w: 1, h: 1, x: 0, y: 0 }] },
      })[0].code,
    ).toBe("port_analytics_invalid_dashboard");
  });

  it("validateConfig accepts a structurally-valid embedded drizzle-cube dashboard (both names)", () => {
    expect(vc(ANALYTICS_PORTLET_KIND, { dashboard: goodDashboard })).toEqual([]);
    expect(vc(ANALYTICS_PORTLET_KIND_ALIAS, { dashboard: goodDashboard })).toEqual([]);
  });

  it("the apiVersion 1.2 registry-backed validator ACCEPTS an analytics portlet once the kind is registered", () => {
    // This is the keystone seam: registering the kind makes an apiVersion 1.2
    // config carrying an `analytics` portlet validate (kind existence is checked
    // via getPortletKind). Pre-#325 this kind was unknown → the config was rejected.
    const v12 = {
      apiVersion: DASHBOARD_CONFIG_V12_VERSION,
      scopeLevel: "user",
      portlets: [
        {
          instanceId: "analytics",
          kind: "analytics",
          version: "1.0.0",
          slot: "fixed",
          config: { dashboard: goodDashboard },
        },
      ],
    };
    const res = validateDashboardConfigV12(v12, { getPortletKind: getPortletKindDescriptor });
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });
});

// cinatra#1512: a single executable query must be cube-scoped — the query
// endpoint rejects mixed-cube queries with `cube_id_ambiguous`, so a portlet
// that mixes cubes in one query can never render. The write path (every save
// funnels through the mutation service's registry validation) fails closed
// with product copy instead of persisting a permanently-broken card.
describe("analytics portlet cross-cube query validation (cinatra#1512)", () => {
  const embed = (portlet: Record<string, unknown>) => ({
    dashboard: {
      portlets: [{ id: "p1", title: "Runs", w: 3, h: 4, x: 0, y: 0, ...portlet }],
      layoutMode: "grid",
      grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
    },
  });
  const queryAnalysis = (
    query: unknown,
    chartType = "bar",
  ): Record<string, unknown> => ({
    analysisConfig: {
      version: 1,
      analysisType: "query",
      activeView: "chart",
      charts: { query: { chartType, chartConfig: {}, displayConfig: {} } },
      query,
    },
  });

  it("rejects the issue-#1512 repro: a kpiNumber query spanning agent_runs/teams/projects", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(
        queryAnalysis(
          {
            measures: [
              "agent_runs.count",
              "agent_runs.last_run_at",
              "teams.count",
              "teams.member_count",
              "projects.count",
            ],
            dimensions: [],
          },
          "kpiNumber",
        ),
      ),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("port_analytics_cross_cube_query");
    expect(errs[0].message).toContain('card "Runs"');
    expect(errs[0].message).toContain(
      "mixes fields from Agent Runs, Teams, and Projects",
    );
    expect(errs[0].message).toContain("create a separate KPI card per data source");
  });

  it("rejects a cross-cube single query for non-KPI charts too (generic copy)", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(queryAnalysis({ measures: ["agent_runs.count", "teams.count"] })),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("port_analytics_cross_cube_query");
    expect(errs[0].message).toContain("mixes fields from Agent Runs and Teams");
    expect(errs[0].message).not.toContain("KPI");
  });

  it("catches a foreign cube referenced only through a filter / order key", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(
        queryAnalysis({
          measures: ["agent_runs.count"],
          filters: [{ member: "teams.id", operator: "equals", values: ["t1"] }],
          order: { "projects.count": "desc" },
        }),
      ),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("port_analytics_cross_cube_query");
  });

  it("accepts a single-cube query using every member surface", () => {
    expect(
      vc(
        ANALYTICS_PORTLET_KIND,
        embed(
          queryAnalysis({
            measures: ["teams.member_count"],
            dimensions: ["teams.name"],
            filters: [{ member: "teams.id", operator: "equals", values: ["t1"] }],
            order: { "teams.member_count": "desc" },
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("accepts a non-KPI multi-query config spanning cubes ACROSS sub-queries", () => {
    expect(
      vc(
        ANALYTICS_PORTLET_KIND,
        embed(
          queryAnalysis({
            queries: [
              { measures: ["agent_runs.count"] },
              { measures: ["teams.count"] },
            ],
            mergeStrategy: "concat",
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("rejects a multi-query config whose individual sub-query mixes cubes", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(
        queryAnalysis({
          queries: [
            { measures: ["agent_runs.count", "teams.count"] },
            { measures: ["projects.count"] },
          ],
          mergeStrategy: "concat",
        }),
      ),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("port_analytics_cross_cube_query");
  });

  it("rejects a KPI multi-query whose sub-queries span cubes even when each is single-cube", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(
        queryAnalysis(
          {
            queries: [
              { measures: ["agent_runs.count"] },
              { measures: ["teams.count"] },
            ],
            mergeStrategy: "concat",
          },
          "kpiNumber",
        ),
      ),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toContain("create a separate KPI card per data source");
  });

  it("checks the legacy top-level query field (object AND JSON-string forms)", () => {
    const legacyObject = {
      query: { measures: ["agent_runs.count", "teams.count"] },
      chartType: "bar",
    };
    expect(vc(ANALYTICS_PORTLET_KIND, embed(legacyObject))[0].code).toBe(
      "port_analytics_cross_cube_query",
    );
    const legacyString = {
      query: JSON.stringify({ measures: ["agent_runs.count", "teams.count"] }),
      chartType: "bar",
    };
    expect(vc(ANALYTICS_PORTLET_KIND, embed(legacyString))[0].code).toBe(
      "port_analytics_cross_cube_query",
    );
  });

  it("rejects an unparseable legacy query string (cinatra#1736 — DC's JSON.parse would spin forever)", () => {
    // Pre-#1736 this was tolerated ("drizzle-cube owns invalid-JSON handling")
    // — but DC "handles" it with a console.warn and an indefinite spinner. The
    // write boundary now rejects it with the contract message instead.
    const errs = vc(ANALYTICS_PORTLET_KIND, embed({ query: "not json {", chartType: "bar" }));
    expect(errs).toHaveLength(1);
    expect(errs[0]!.code).toBe("port_analytics_invalid_dashboard");
    expect(errs[0]!.message).toContain("must be a JSON string");
  });

  it("skips funnel/flow/retention analysis types (different query DSLs, not served in v1)", () => {
    expect(
      vc(
        ANALYTICS_PORTLET_KIND,
        embed({
          analysisConfig: {
            version: 1,
            analysisType: "funnel",
            activeView: "chart",
            charts: { funnel: { chartType: "funnel", chartConfig: {}, displayConfig: {} } },
            query: {
              funnel: {
                bindingKey: "agent_runs.id",
                timeDimension: "teams.created_at",
                steps: [],
              },
            },
          },
        }),
      ),
    ).toEqual([]);
  });

  it("the registry-backed apiVersion 1.2 path (the mutation-service sequence) rejects a cross-cube portlet", () => {
    // Mirror assertConfigV12's two stages: structural v12 validation, then
    // per-kind config validation via the live registry — the exact sequence
    // every dashboard save runs (mutation-service.ts). The structural stage
    // passes (the envelope is well-formed); the per-kind stage carries the
    // cross-cube rejection.
    const v12 = {
      apiVersion: DASHBOARD_CONFIG_V12_VERSION,
      scopeLevel: "user",
      portlets: [
        {
          instanceId: "analytics",
          kind: "analytics",
          version: "1.0.0",
          slot: "fixed",
          config: embed(
            queryAnalysis(
              { measures: ["agent_runs.count", "teams.count"] },
              "kpiNumber",
            ),
          ),
        },
      ],
    };
    const res = validateDashboardConfigV12(v12, { getPortletKind: getPortletKindDescriptor });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const p = res.config.portlets[0];
    const errs = validatePortletConfig(p.kind, p.version, {
      config: p.config,
      inputs: p.inputs,
      outputs: p.outputs,
    });
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("port_analytics_cross_cube_query");
  });
});

// cinatra#1911: a query the v1 endpoint rejects with
// `unsupported_query_feature` must not persist — write-time rejection with
// the SAME predicate + product copy as the wire gate (single source of truth
// in sdk-dashboard). Messages are keyed by the STABLE card id (never the
// display title) so the #1913 error-multiset grandfathering is rename-proof.
describe("analytics portlet executable-feature validation (cinatra#1911)", () => {
  const embed = (portlet: Record<string, unknown>) => ({
    dashboard: {
      portlets: [{ id: "card-1911", title: "Runs over time", w: 3, h: 4, x: 0, y: 0, ...portlet }],
      layoutMode: "grid",
      grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
    },
  });
  const queryAnalysis = (query: unknown): Record<string, unknown> => ({
    analysisConfig: {
      version: 1,
      analysisType: "query",
      activeView: "chart",
      charts: { query: { chartType: "line", chartConfig: {}, displayConfig: {} } },
      query,
    },
  });

  it("accepts the issue-#1911 reference query shapes (timeDimensions / inDateRange / in)", () => {
    expect(
      vc(
        ANALYTICS_PORTLET_KIND,
        embed(
          queryAnalysis({
            measures: ["agent_runs.count"],
            timeDimensions: [
              { dimension: "agent_runs.created_at", granularity: "day", dateRange: "last 30 days" },
            ],
          }),
        ),
      ),
    ).toEqual([]);
    expect(
      vc(
        ANALYTICS_PORTLET_KIND,
        embed(
          queryAnalysis({
            measures: ["agent_runs.count"],
            dimensions: ["agent_runs.agent_id"],
            filters: [
              { member: "agent_runs.status", operator: "in", values: ["failed", "stopped"] },
              { member: "agent_runs.created_at", operator: "inDateRange", values: ["last 30 days"] },
            ],
          }),
        ),
      ),
    ).toEqual([]);
  });

  it("rejects an unsupported filter operator with card-id-keyed product copy", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(
        queryAnalysis({
          measures: ["agent_runs.count"],
          filters: [{ member: "agent_runs.status", operator: "contains", values: ["fail"] }],
        }),
      ),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("port_analytics_unsupported_query_feature");
    // Identity is the stable card id, NOT the display title (rename-proof
    // under the #1913 grandfathering multiset).
    expect(errs[0].message).toContain("card card-1911:");
    expect(errs[0].message).not.toContain("Runs over time");
    expect(errs[0].message).toContain('"contains"');
    expect(errs[0].message).toContain("inDateRange");
  });

  it("rejects grouped and/or filters and granularity-less timeDimensions", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(
        queryAnalysis({
          measures: ["agent_runs.count"],
          filters: [{ or: [{ member: "agent_runs.status", operator: "equals", values: ["ok"] }] }],
          timeDimensions: [{ dimension: "agent_runs.created_at" }],
        }),
      ),
    );
    expect(errs.map((e) => e.code)).toEqual([
      "port_analytics_unsupported_query_feature",
      "port_analytics_unsupported_query_feature",
    ]);
    expect(errs[0].message).toContain("Grouped and/or filters");
    expect(errs[1].message).toContain("granularity");
  });

  it("checks the legacy JSON-string query path too", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed({
        query: JSON.stringify({
          measures: ["agent_runs.count"],
          filters: [{ member: "agent_runs.status", operator: "notIn", values: ["ok"] }],
        }),
        chartType: "bar",
      }),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("port_analytics_unsupported_query_feature");
    expect(errs[0].message).toContain('"notIn"');
  });

  it("checks each sub-query of a multi-query config individually", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(
        queryAnalysis({
          queries: [
            { measures: ["agent_runs.count"] },
            {
              measures: ["agent_runs.count"],
              filters: [{ member: "agent_runs.status", operator: "gte", values: ["1"] }],
            },
          ],
        }),
      ),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0].code).toBe("port_analytics_unsupported_query_feature");
  });

  it("rejects a query over the shared complexity cap with the same arithmetic as the endpoint", () => {
    const errs = vc(
      ANALYTICS_PORTLET_KIND,
      embed(
        queryAnalysis({
          measures: Array.from({ length: 20 }, (_, i) => `agent_runs.m${i}`),
          dimensions: Array.from({ length: 20 }, (_, i) => `agent_runs.d${i}`),
        }),
      ),
    );
    expect(errs.some((e) => e.code === "port_analytics_query_too_complex")).toBe(true);
  });
});
