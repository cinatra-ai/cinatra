// Covers the Environment "Connections" tab dev/prod gating + the legacy
// `?tab=credentials` continuity alias (the wave's one URL-contract rename).
// A regression where prod started rendering the tab, or where the prod
// alias silently landed users on a blank state, would otherwise only be
// caught at admin UAT.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime-mode", () => ({
  isAppDevelopmentMode: vi.fn(),
}));

import { isAppDevelopmentMode } from "@/lib/runtime-mode";
import {
  buildTabs,
  resolveEnvTab,
  CONNECTIONS_TAB_VALUE,
  LEGACY_CONNECTIONS_TAB_VALUE,
} from "../environment-tabs";

const mockedIsDevMode = vi.mocked(isAppDevelopmentMode);

function setDevMode(isDev: boolean) {
  mockedIsDevMode.mockReturnValue(isDev);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("buildTabs — dev/prod gating", () => {
  it("appends the Connections tab as the 4th entry in dev mode", () => {
    setDevMode(true);
    const tabs = buildTabs();
    expect(tabs.map((t) => t.value)).toEqual([
      "mode",
      "instance",
      "registries",
      CONNECTIONS_TAB_VALUE,
    ]);
    expect(tabs[3]).toEqual({ value: "connections", label: "Connections" });
  });

  it("hides the Connections tab in production mode (exactly 3 tabs)", () => {
    setDevMode(false);
    const tabs = buildTabs();
    expect(tabs.map((t) => t.value)).toEqual(["mode", "instance", "registries"]);
    expect(tabs.some((t) => t.value === CONNECTIONS_TAB_VALUE)).toBe(false);
  });
});

describe("resolveEnvTab — alias + fallback", () => {
  it("dev: ?tab=credentials aliases to connections", () => {
    setDevMode(true);
    const tabs = buildTabs();
    const r = resolveEnvTab(LEGACY_CONNECTIONS_TAB_VALUE, tabs);
    expect(r.tab).toBe(CONNECTIONS_TAB_VALUE);
    expect(r.requestedConnections).toBe(false);
  });

  it("dev: ?tab=connections renders the connections tab directly", () => {
    setDevMode(true);
    const tabs = buildTabs();
    const r = resolveEnvTab(CONNECTIONS_TAB_VALUE, tabs);
    expect(r.tab).toBe(CONNECTIONS_TAB_VALUE);
    expect(r.requestedConnections).toBe(false);
  });

  it("prod: ?tab=credentials falls back to mode + flags the redirect", () => {
    setDevMode(false);
    const tabs = buildTabs();
    const r = resolveEnvTab(LEGACY_CONNECTIONS_TAB_VALUE, tabs);
    expect(r.tab).toBe("mode");
    expect(r.requestedConnections).toBe(true);
  });

  it("prod: ?tab=connections falls back to mode + flags the redirect", () => {
    setDevMode(false);
    const tabs = buildTabs();
    const r = resolveEnvTab(CONNECTIONS_TAB_VALUE, tabs);
    expect(r.tab).toBe("mode");
    expect(r.requestedConnections).toBe(true);
  });

  it("a known tab resolves to itself with no redirect flag (both modes)", () => {
    for (const dev of [true, false]) {
      setDevMode(dev);
      const tabs = buildTabs();
      const r = resolveEnvTab("registries", tabs);
      expect(r.tab).toBe("registries");
      expect(r.requestedConnections).toBe(false);
    }
  });

  it("an unknown tab falls back to mode without flagging a connections redirect", () => {
    setDevMode(true);
    const tabs = buildTabs();
    const r = resolveEnvTab("does-not-exist", tabs);
    expect(r.tab).toBe("mode");
    expect(r.requestedConnections).toBe(false);
  });
});
