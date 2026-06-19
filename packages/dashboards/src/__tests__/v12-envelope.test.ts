import { describe, expect, it } from "vitest";

import {
  ANALYTICS_PORTLET_INSTANCE_ID,
  isV12Envelope,
  ownerLevelToScopeLevel,
  readDcConfigFromRow,
  reEnvelopeDcSave,
  unwrapV12ToDc,
  wrapDcAsV12,
} from "../v12-envelope";
import {
  DASHBOARD_CONFIG_V12_VERSION,
  validateDashboardConfigV12,
} from "../extension/dashboard-config-v12";
import {
  ANALYTICS_PORTLET_KIND,
  ANALYTICS_PORTLET_VERSION,
  registerCorePortletKinds,
} from "../portlets/kinds";
import { getPortletKindDescriptor, validatePortletConfig } from "../portlets/registry";
import {
  AGENTS_DEFAULT_CONFIG,
} from "../components/seed-configs/agents-default";
import { parseDashboardConfig } from "../store/dashboard-config";

// A minimal valid drizzle-cube DashboardConfig (the 1.1 embedded shape).
const DC = {
  portlets: [
    {
      id: "p1",
      title: "Bar",
      w: 6,
      h: 8,
      x: 0,
      y: 0,
      analysisConfig: {
        query: { measures: ["agent_runs.count"], dimensions: ["agent_runs.agent_name"] },
      },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
} as const;

describe("v12-envelope — ownerLevelToScopeLevel", () => {
  it("maps the four owner levels to identity scopeLevels", () => {
    expect(ownerLevelToScopeLevel("user")).toBe("user");
    expect(ownerLevelToScopeLevel("team")).toBe("team");
    expect(ownerLevelToScopeLevel("organization")).toBe("organization");
    expect(ownerLevelToScopeLevel("workspace")).toBe("workspace");
  });
  it("defaults an unrecognized owner level to 'user' (corrupt-row guard)", () => {
    expect(ownerLevelToScopeLevel("bogus")).toBe("user");
    expect(ownerLevelToScopeLevel("")).toBe("user");
  });
});

describe("v12-envelope — isV12Envelope", () => {
  it("detects an apiVersion 1.2 envelope", () => {
    expect(isV12Envelope(wrapDcAsV12(DC, "user"))).toBe(true);
  });
  it("rejects bare DC / legacy / non-objects", () => {
    expect(isV12Envelope(DC)).toBe(false);
    expect(isV12Envelope({ portlets: [] })).toBe(false);
    expect(isV12Envelope(null)).toBe(false);
    // A bare string equal to the apiVersion literal is NOT an envelope (no object).
    expect(isV12Envelope(DASHBOARD_CONFIG_V12_VERSION)).toBe(false);
    expect(isV12Envelope({ apiVersion: "1.1.0" })).toBe(false);
  });
});

describe("v12-envelope — wrapDcAsV12", () => {
  it("wraps a bare DC into a single fixed analytics portlet at config.dashboard", () => {
    const env = wrapDcAsV12(DC, "organization");
    expect(env.apiVersion).toBe(DASHBOARD_CONFIG_V12_VERSION);
    expect(env.scopeLevel).toBe("organization");
    expect(env.portlets).toHaveLength(1);
    const p = env.portlets[0];
    expect(p.instanceId).toBe(ANALYTICS_PORTLET_INSTANCE_ID);
    expect(p.kind).toBe(ANALYTICS_PORTLET_KIND);
    expect(p.version).toBe(ANALYTICS_PORTLET_VERSION);
    expect(p.slot).toBe("fixed");
    expect((p.config as { dashboard: unknown }).dashboard).toEqual(DC);
  });

  it("produces an envelope that passes the apiVersion 1.2 STRUCTURAL validator", () => {
    const env = wrapDcAsV12(DC, "user");
    const res = validateDashboardConfigV12(env);
    expect(res.ok, JSON.stringify(res)).toBe(true);
  });

  it("produces an envelope whose analytics portlet passes the registry per-kind validateConfig", () => {
    registerCorePortletKinds();
    const env = wrapDcAsV12(DC, "user");
    const res = validateDashboardConfigV12(env, { getPortletKind: getPortletKindDescriptor });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    // per-kind structured config: config.dashboard must be a valid 1.1 DC.
    const errs = validatePortletConfig(ANALYTICS_PORTLET_KIND, ANALYTICS_PORTLET_VERSION, {
      config: env.portlets[0].config,
    });
    expect(errs).toEqual([]);
  });

  it("wraps the real AGENTS_DEFAULT_CONFIG seed into a valid apiVersion 1.2 envelope (round-trips through validateConfig)", () => {
    registerCorePortletKinds();
    const env = wrapDcAsV12(AGENTS_DEFAULT_CONFIG, "user");
    const res = validateDashboardConfigV12(env, { getPortletKind: getPortletKindDescriptor });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    const errs = validatePortletConfig(ANALYTICS_PORTLET_KIND, ANALYTICS_PORTLET_VERSION, {
      config: env.portlets[0].config,
    });
    expect(errs).toEqual([]);
  });
});

describe("v12-envelope — unwrapV12ToDc", () => {
  it("round-trips wrap → unwrap", () => {
    expect(unwrapV12ToDc(wrapDcAsV12(DC, "user"))).toEqual(DC);
  });
  it("returns null for a bare DC / non-analytics envelope", () => {
    expect(unwrapV12ToDc(DC)).toBeNull();
    expect(
      unwrapV12ToDc({
        apiVersion: DASHBOARD_CONFIG_V12_VERSION,
        scopeLevel: "user",
        portlets: [{ instanceId: "x", kind: "object-list", version: "1.0.0", slot: "fixed", config: {} }],
      }),
    ).toBeNull();
  });
  it("unwraps the cube-dashboard alias kind too", () => {
    const env = {
      apiVersion: DASHBOARD_CONFIG_V12_VERSION,
      scopeLevel: "user",
      portlets: [{ instanceId: "analytics", kind: "cube-dashboard", version: "1.0.0", slot: "fixed", config: { dashboard: DC } }],
    };
    expect(unwrapV12ToDc(env)).toEqual(DC);
  });
});

describe("v12-envelope — reEnvelopeDcSave", () => {
  it("fresh-wraps when the existing config is not an apiVersion 1.2 envelope", () => {
    const next = reEnvelopeDcSave(undefined, DC, "team");
    expect(next.scopeLevel).toBe("team");
    expect(unwrapV12ToDc(next)).toEqual(DC);
  });

  it("preserves scopeLevel + sibling portlets, replacing ONLY the analytics dashboard", () => {
    const sibling = { instanceId: "launcher", kind: "agent-launcher", version: "1.0.0", slot: "optional", config: { agentRef: "x" } };
    const existing = {
      apiVersion: DASHBOARD_CONFIG_V12_VERSION,
      scopeLevel: "organization",
      portlets: [
        { instanceId: ANALYTICS_PORTLET_INSTANCE_ID, kind: ANALYTICS_PORTLET_KIND, version: "1.0.0", slot: "fixed", config: { dashboard: { portlets: [] }, title: "keep-me" } },
        sibling,
      ],
    };
    const nextDc = { ...DC, layoutMode: "rows" as const };
    const next = reEnvelopeDcSave(existing, nextDc, "user");
    expect(next.scopeLevel).toBe("organization"); // inherited, not the fallback
    expect(next.portlets).toHaveLength(2);
    // sibling preserved verbatim.
    expect(next.portlets.find((p) => p.instanceId === "launcher")).toEqual(sibling);
    // analytics dashboard replaced; OTHER analytics config keys preserved.
    const analytics = next.portlets.find((p) => p.instanceId === ANALYTICS_PORTLET_INSTANCE_ID)!;
    expect((analytics.config as { dashboard: unknown }).dashboard).toEqual(nextDc);
    expect((analytics.config as { title?: string }).title).toBe("keep-me");
  });

  it("re-envelope + unwrap target the SAME analytics portlet even with a non-canonical instanceId (round-trip consistency)", () => {
    // An analytics portlet whose instanceId is NOT the canonical "analytics".
    const existing = {
      apiVersion: DASHBOARD_CONFIG_V12_VERSION,
      scopeLevel: "user",
      portlets: [
        { instanceId: "custom-analytics-id", kind: ANALYTICS_PORTLET_KIND, version: "1.0.0", slot: "fixed", config: { dashboard: { portlets: [] } } },
      ],
    };
    const nextDc = { ...DC, layoutMode: "rows" as const };
    const next = reEnvelopeDcSave(existing, nextDc, "user");
    // No SECOND analytics portlet appended; the existing one was replaced in place.
    expect(next.portlets).toHaveLength(1);
    expect(next.portlets[0].instanceId).toBe("custom-analytics-id");
    // Unwrap reads back exactly what re-envelope wrote (no stale-first-portlet drift).
    expect(unwrapV12ToDc(next)).toEqual(nextDc);
  });

  it("appends an analytics portlet if the existing apiVersion 1.2 envelope had none", () => {
    const existing = {
      apiVersion: DASHBOARD_CONFIG_V12_VERSION,
      scopeLevel: "team",
      portlets: [{ instanceId: "launcher", kind: "agent-launcher", version: "1.0.0", slot: "optional", config: { agentRef: "x" } }],
    };
    const next = reEnvelopeDcSave(existing, DC, "user");
    expect(next.portlets).toHaveLength(2);
    expect(unwrapV12ToDc(next)).toEqual(DC);
    expect(next.scopeLevel).toBe("team");
  });
});

describe("v12-envelope — readDcConfigFromRow", () => {
  const SEED = { portlets: [{ id: "seed", title: "Seed", w: 1, h: 1, x: 0, y: 0, query: {} }] };

  it("returns the seed when the row is absent", () => {
    expect(readDcConfigFromRow(undefined, SEED, parseDashboardConfig)).toBe(SEED);
  });

  it("unwraps an apiVersion 1.2 analytics row back to the bare DC", () => {
    const row = { configVersion: DASHBOARD_CONFIG_V12_VERSION, configJson: wrapDcAsV12(DC, "user") };
    expect(readDcConfigFromRow(row, SEED, parseDashboardConfig)).toEqual(DC);
  });

  it("parses a legacy 1.1 row via the dispatcher", () => {
    const row = { configVersion: "1.1.0", configJson: DC };
    expect(readDcConfigFromRow(row, SEED, parseDashboardConfig)).toEqual(DC);
  });

  it("falls back to the seed for an apiVersion 1.2 row whose embedded dashboard is corrupt", () => {
    const row = {
      configVersion: DASHBOARD_CONFIG_V12_VERSION,
      configJson: {
        apiVersion: DASHBOARD_CONFIG_V12_VERSION,
        scopeLevel: "user",
        portlets: [{ instanceId: "analytics", kind: "analytics", version: "1.0.0", slot: "fixed", config: { dashboard: { portlets: "not-an-array" } } }],
      },
    };
    expect(readDcConfigFromRow(row, SEED, parseDashboardConfig)).toBe(SEED);
  });

  it("falls back to the seed for an apiVersion 1.2 row with no analytics portlet", () => {
    const row = {
      configVersion: DASHBOARD_CONFIG_V12_VERSION,
      configJson: { apiVersion: DASHBOARD_CONFIG_V12_VERSION, scopeLevel: "user", portlets: [] },
    };
    expect(readDcConfigFromRow(row, SEED, parseDashboardConfig)).toBe(SEED);
  });

  it("falls back to the seed for an unknown version", () => {
    const row = { configVersion: "9.9.9", configJson: DC };
    expect(readDcConfigFromRow(row, SEED, parseDashboardConfig)).toBe(SEED);
  });
});
