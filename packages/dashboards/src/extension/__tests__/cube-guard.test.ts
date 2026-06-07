import { describe, expect, it } from "vitest";

import {
  PORTLET_CUBE_CONFIG_FIELDS,
  validateExtensionCubeUsage,
} from "../cube-guard";
import type { DashboardConfigV12 } from "../dashboard-config-v12";

const KNOWN_CUBES = ["agent_runs", "projects", "teams", "organizations", "artifacts"];

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
    apiVersion: "v1.2",
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
