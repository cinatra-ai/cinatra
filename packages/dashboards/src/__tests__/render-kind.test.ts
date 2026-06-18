import { describe, expect, it } from "vitest";

import { resolveDashboardRenderKind } from "../render-kind";
import { AGENTS_DEFAULT_CONFIG } from "../components/seed-configs/agents-default";
import { DASHBOARD_CONFIG_V12_VERSION } from "../extension/dashboard-config-v12";

/**
 * Regression for cinatra#272.
 *
 * The `/dashboards/[id]` renderer previously ran the apiVersion 1.2-only
 * validator unconditionally, so an agent-created dashboard (config_version
 * "1.1.0", legacy drizzle-cube config) was rejected with the "Unsupported
 * dashboard format" card. `resolveDashboardRenderKind` is the pure dispatch
 * that fixes this: a legacy row resolves to "legacy" (NOT "unsupported"), an
 * apiVersion 1.2 row to "v12", and only a genuinely unknown version/shape to
 * "unsupported".
 */

// A structurally valid extension apiVersion 1.2 config (mirrors the v12 test fixture).
const V12_CONFIG = {
  apiVersion: DASHBOARD_CONFIG_V12_VERSION,
  scopeLevel: "project",
  portlets: [
    { instanceId: "list", kind: "object-list", version: "1.0.0", slot: "fixed", config: {}, outputs: ["selectedId"] },
  ],
};

// A legacy 1.0.0 config — type-discriminated portlets, no w/h/x/y. Parses
// cleanly against the permissive 1.0.0 schema (`DashboardConfigV1Schema`).
const LEGACY_V1_0_CONFIG = {
  portlets: [{ id: "p1", type: "chart" }],
};

describe("resolveDashboardRenderKind (cinatra#272)", () => {
  it("routes an agent-created config_version 1.1.0 row to 'legacy' (the #272 repro)", () => {
    expect(resolveDashboardRenderKind("1.1.0", AGENTS_DEFAULT_CONFIG)).toBe("legacy");
  });

  it("routes a config_version 1.0.0 row that parses against the 1.0.0 schema to 'legacy'", () => {
    expect(resolveDashboardRenderKind("1.0.0", LEGACY_V1_0_CONFIG)).toBe("legacy");
  });

  it("routes a row whose payload does not parse against its declared legacy version to 'unsupported'", () => {
    // A 1.1-shaped payload tagged config_version 1.0.0 fails the 1.0.0 schema
    // (the 1.0.0 portlet shape requires `type`), so it is not rendered.
    expect(resolveDashboardRenderKind("1.0.0", AGENTS_DEFAULT_CONFIG)).toBe("unsupported");
  });

  it("routes a valid apiVersion 1.2 row to 'v12'", () => {
    expect(resolveDashboardRenderKind(DASHBOARD_CONFIG_V12_VERSION, V12_CONFIG)).toBe("v12");
  });

  it("routes an unknown config_version to 'unsupported'", () => {
    expect(resolveDashboardRenderKind("9.0.0", AGENTS_DEFAULT_CONFIG)).toBe("unsupported");
  });

  it("routes an apiVersion 1.2 version label with a non-1.2 payload to 'unsupported'", () => {
    // Mislabeled row: config_version says 1.2 but the JSON is a legacy shape.
    expect(resolveDashboardRenderKind(DASHBOARD_CONFIG_V12_VERSION, AGENTS_DEFAULT_CONFIG)).toBe("unsupported");
  });

  it("routes a known legacy version with a payload that parses against neither family to 'unsupported'", () => {
    // config_version 1.1.0 but the payload is not a valid legacy config
    // (portlet missing required title/layout + content spec).
    expect(resolveDashboardRenderKind("1.1.0", { portlets: [{ id: "x" }] })).toBe("unsupported");
  });

  it("agent-created 1.1.0 row NEVER resolves to 'unsupported' (direct #272 assertion)", () => {
    // The exact bug: a config the agent create path produces must not hit the
    // 'Unsupported dashboard format' card.
    expect(resolveDashboardRenderKind("1.1.0", AGENTS_DEFAULT_CONFIG)).not.toBe("unsupported");
  });

  it("routes an apiVersion 1.2 ANALYTICS row (the #325 keystone shape) to 'v12' → PortletHost", () => {
    // The §2e acceptance row: an apiVersion 1.2 config whose single portlet is
    // the `analytics` kind wrapping a whole drizzle-cube DashboardConfig at
    // config.dashboard. resolveDashboardRenderKind validates structurally (no
    // registry), so the strict apiVersion 1.2 schema must accept the analytics portlet
    // (config is z.record(string, unknown) → config.dashboard passes opaquely),
    // routing it to "v12" — i.e. `[id]/page.tsx` mounts <PortletHost>, which
    // renders the embedded analytics grid. This binds the keystone render path.
    const ANALYTICS_V12_ROW = {
      apiVersion: DASHBOARD_CONFIG_V12_VERSION,
      scopeLevel: "user",
      portlets: [
        {
          instanceId: "analytics",
          kind: "analytics",
          version: "1.0.0",
          slot: "fixed",
          config: { dashboard: AGENTS_DEFAULT_CONFIG },
        },
      ],
    };
    expect(resolveDashboardRenderKind(DASHBOARD_CONFIG_V12_VERSION, ANALYTICS_V12_ROW)).toBe("v12");
  });
});
