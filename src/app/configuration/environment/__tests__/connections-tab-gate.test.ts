// Covers the RETIRED Environment "Connections" tab (cinatra#35) + the
// legacy `?tab=connections|credentials` continuity fallback. The tab's inline
// Nango settings section was the last consumer of the host's
// `@/lib/nango-settings-section` re-export facade; connection-service
// configuration lives on /setup/connections in BOTH runtime modes. A
// regression where the tab set re-grows the retired value, or where the
// legacy URLs silently land users on a blank state instead of the flagged
// Mode fallback, would otherwise only be caught at admin UAT.

import { describe, expect, it } from "vitest";

import {
  buildTabs,
  resolveEnvTab,
  CONNECTIONS_TAB_VALUE,
  LEGACY_CONNECTIONS_TAB_VALUE,
} from "../environment-tabs";

describe("buildTabs — Connections tab is retired", () => {
  it("offers exactly mode/instance/registries (no connections tab)", () => {
    const tabs = buildTabs();
    expect(tabs.map((t) => t.value)).toEqual(["mode", "instance", "registries"]);
    expect(tabs.some((t) => t.value === CONNECTIONS_TAB_VALUE)).toBe(false);
    expect(tabs.some((t) => t.value === LEGACY_CONNECTIONS_TAB_VALUE)).toBe(false);
  });
});

describe("resolveEnvTab — retired-tab fallback + unknown-value fallback", () => {
  it("?tab=connections falls back to mode + flags the redirect", () => {
    const tabs = buildTabs();
    const r = resolveEnvTab(CONNECTIONS_TAB_VALUE, tabs);
    expect(r.tab).toBe("mode");
    expect(r.requestedConnections).toBe(true);
  });

  it("?tab=credentials (legacy) falls back to mode + flags the redirect", () => {
    const tabs = buildTabs();
    const r = resolveEnvTab(LEGACY_CONNECTIONS_TAB_VALUE, tabs);
    expect(r.tab).toBe("mode");
    expect(r.requestedConnections).toBe(true);
  });

  it("a known tab resolves to itself with no redirect flag", () => {
    const tabs = buildTabs();
    for (const value of ["mode", "instance", "registries"]) {
      const r = resolveEnvTab(value, tabs);
      expect(r.tab).toBe(value);
      expect(r.requestedConnections).toBe(false);
    }
  });

  it("an unknown tab falls back to mode without flagging a connections redirect", () => {
    const tabs = buildTabs();
    const r = resolveEnvTab("does-not-exist", tabs);
    expect(r.tab).toBe("mode");
    expect(r.requestedConnections).toBe(false);
  });
});
