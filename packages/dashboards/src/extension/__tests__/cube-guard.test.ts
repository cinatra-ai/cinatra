import { describe, expect, it } from "vitest";

import {
  PORTLET_CUBE_CONFIG_FIELDS,
  validateExtensionCubeUsage,
} from "../cube-guard";
import { DASHBOARD_CONFIG_V12_VERSION, type DashboardConfigV12 } from "../dashboard-config-v12";

const KNOWN_CUBES = ["agent_runs", "projects", "teams", "organizations", "artifacts", "llm_usage"];

function portlet(config: Record<string, unknown>, instanceId = "p1") {
  return {
    instanceId,
    kind: "chart",
    version: "1.0.0",
    slot: "fixed" as const,
    config,
  };
}

function dashboard(portlets: ReturnType<typeof portlet>[]): DashboardConfigV12 {
  return {
    apiVersion: DASHBOARD_CONFIG_V12_VERSION,
    scopeLevel: "project",
    portlets,
  } as DashboardConfigV12;
}

describe("validateExtensionCubeUsage", () => {
  it("returns ok when no dashboard and no contributions", () => {
    const r = validateExtensionCubeUsage({}, { knownCubes: KNOWN_CUBES });
    expect(r.verdict).toBe("ok");
    expect(r.offendingCubes).toBeUndefined();
  });

  it("returns ok when every portlet references a registered cube (cube field)", () => {
    const r = validateExtensionCubeUsage(
      { dashboardConfig: dashboard([portlet({ cube: "agent_runs" })]) },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("returns ok via the cubeRef alias field", () => {
    const r = validateExtensionCubeUsage(
      { dashboardConfig: dashboard([portlet({ cubeRef: "projects" })]) },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("returns ok for a portlet referencing the registered llm_usage cube", () => {
    const r = validateExtensionCubeUsage(
      { dashboardConfig: dashboard([portlet({ cube: "llm_usage" })]) },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("returns ok when portlets carry no cube reference at all", () => {
    const r = validateExtensionCubeUsage(
      { dashboardConfig: dashboard([portlet({ typeId: "note" })]) },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("rejects a portlet referencing an unknown cube (cube field)", () => {
    const r = validateExtensionCubeUsage(
      { dashboardConfig: dashboard([portlet({ cube: "ext_custom_metric" })]) },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(r.offendingCubes).toEqual(["ext_custom_metric"]);
    expect(r.reason).toMatch(/unregistered cube/i);
  });

  it("rejects an unknown cube referenced via cubeRef", () => {
    const r = validateExtensionCubeUsage(
      { dashboardConfig: dashboard([portlet({ cubeRef: "ext_custom_metric" })]) },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(r.offendingCubes).toEqual(["ext_custom_metric"]);
  });

  it("collects every distinct unknown cube across portlets, deduped", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          portlet({ cube: "unknown_a" }, "p1"),
          portlet({ cubeRef: "unknown_b" }, "p2"),
          portlet({ cube: "unknown_a" }, "p3"),
          portlet({ cube: "projects" }, "p4"),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(new Set(r.offendingCubes)).toEqual(new Set(["unknown_a", "unknown_b"]));
  });

  it("returns requires-rebuild when the package declares cube contributions", () => {
    const r = validateExtensionCubeUsage(
      { declaredCubeContributions: ["ext_new_cube"] },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("requires-rebuild");
    expect(r.offendingCubes).toEqual(["ext_new_cube"]);
    expect(r.reason).toMatch(/static boot|rebuild|restart/i);
  });

  it("prefers requires-rebuild over reject when a package both declares and misreferences cubes", () => {
    const r = validateExtensionCubeUsage(
      {
        declaredCubeContributions: ["ext_new_cube"],
        dashboardConfig: dashboard([portlet({ cube: "also_unknown" })]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("requires-rebuild");
    expect(r.offendingCubes).toEqual(["ext_new_cube"]);
  });

  it("ignores empty-string / non-string cube config values", () => {
    const r = validateExtensionCubeUsage(
      { dashboardConfig: dashboard([portlet({ cube: "", cubeRef: 42 })]) },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("ignores empty-string declared contributions", () => {
    const r = validateExtensionCubeUsage(
      { declaredCubeContributions: ["", ""] },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("exposes the documented cube config field names", () => {
    expect(PORTLET_CUBE_CONFIG_FIELDS).toEqual(["cube", "cubeRef"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// analytics keystone kind (cinatra#325): cube refs live INSIDE the embedded DC
// dashboard at config.dashboard.portlets[].analysisConfig.query.* — NOT in a
// flat cube/cubeRef field. The guard must extract from every cube-bearing query
// surface so an unknown cube referenced solely through a filter, a segment, or a
// timeDimension is still rejected (a filter/segment-only bypass would be a real
// fail-open for an extension-shipped analytics dashboard).
// ───────────────────────────────────────────────────────────────────────────
function analyticsPortlet(dashboard: unknown, kind = "analytics", instanceId = "analytics") {
  return {
    instanceId,
    kind,
    version: "1.0.0",
    slot: "fixed" as const,
    config: { dashboard },
  };
}

/** Build a one-portlet DC dashboard whose single portlet carries `query` under
 *  analysisConfig (the canonical shape). */
function dcDashboard(query: Record<string, unknown>) {
  return {
    portlets: [
      {
        id: "p",
        title: "P",
        w: 6,
        h: 8,
        x: 0,
        y: 0,
        analysisConfig: { version: 1, analysisType: "query", query },
      },
    ],
    layoutMode: "grid",
    grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
  };
}

describe("validateExtensionCubeUsage — analytics (embedded DC) kind", () => {
  it("returns ok when the embedded dashboard references only registered cubes (measures/dimensions)", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          analyticsPortlet(
            dcDashboard({
              measures: ["agent_runs.count"],
              dimensions: ["agent_runs.agent_name"],
              order: { "agent_runs.count": "desc" },
            }),
          ),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("rejects an unknown cube referenced through measures", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          analyticsPortlet(dcDashboard({ measures: ["ext_unknown.count"] })),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(r.offendingCubes).toEqual(["ext_unknown"]);
  });

  it("rejects an unknown cube referenced ONLY through filters[].member (the load-bearing detail-seed case)", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          analyticsPortlet(
            dcDashboard({
              measures: ["teams.member_count"],
              dimensions: ["teams.name"],
              // unknown cube reached SOLELY via a filter — entity-detail-config.ts
              // scopes detail dashboards exactly like this.
              filters: [{ member: "ext_secret.id", operator: "equals", values: ["x"] }],
            }),
          ),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(r.offendingCubes).toEqual(["ext_secret"]);
  });

  it("rejects an unknown cube referenced ONLY through segments (codex round-0 BLOCKER — cubejs-wire resolves cube ids from segments)", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          analyticsPortlet(
            dcDashboard({
              measures: ["agent_runs.count"],
              segments: ["ext_segmented.active"],
            }),
          ),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(r.offendingCubes).toEqual(["ext_segmented"]);
  });

  it("rejects an unknown cube referenced ONLY through timeDimensions[].dimension", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          analyticsPortlet(
            dcDashboard({
              measures: ["agent_runs.count"],
              timeDimensions: [{ dimension: "ext_time.occurred_at", granularity: "day" }],
            }),
          ),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(r.offendingCubes).toEqual(["ext_time"]);
  });

  it("extracts cube refs from a top-level DC portlet `query` (legacy DC portlet field), not just analysisConfig.query", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          analyticsPortlet({
            portlets: [
              { id: "p", title: "P", w: 6, h: 8, x: 0, y: 0, query: { measures: ["ext_legacy.count"] } },
            ],
            layoutMode: "grid",
            grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
          }),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(r.offendingCubes).toEqual(["ext_legacy"]);
  });

  it("applies the same extraction to the `cube-dashboard` alias kind", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          analyticsPortlet(dcDashboard({ measures: ["ext_alias.count"] }), "cube-dashboard"),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(r.offendingCubes).toEqual(["ext_alias"]);
  });

  it("ignores a flat cube/cubeRef field on an analytics portlet (refs only come from the embedded query)", () => {
    // An analytics portlet must NOT be matched by the flat cube/cubeRef path —
    // a stray top-level `cube` is not how analytics references cubes, and the
    // embedded dashboard here is clean → ok.
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          {
            instanceId: "analytics",
            kind: "analytics",
            version: "1.0.0",
            slot: "fixed" as const,
            config: { cube: "ext_should_be_ignored", dashboard: dcDashboard({ measures: ["agent_runs.count"] }) },
          },
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("returns ok when the embedded dashboard has no portlets / no query", () => {
    const r = validateExtensionCubeUsage(
      { dashboardConfig: dashboard([analyticsPortlet({ portlets: [] })]) },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("ok");
  });

  it("collects multiple distinct unknown cubes across surfaces, deduped", () => {
    const r = validateExtensionCubeUsage(
      {
        dashboardConfig: dashboard([
          analyticsPortlet(
            dcDashboard({
              measures: ["unk_a.count"],
              dimensions: ["unk_b.name"],
              segments: ["unk_a.flag"],
              filters: [{ member: "unk_c.id", operator: "equals", values: ["x"] }],
            }),
          ),
        ]),
      },
      { knownCubes: KNOWN_CUBES },
    );
    expect(r.verdict).toBe("reject");
    expect(new Set(r.offendingCubes)).toEqual(new Set(["unk_a", "unk_b", "unk_c"]));
  });
});
