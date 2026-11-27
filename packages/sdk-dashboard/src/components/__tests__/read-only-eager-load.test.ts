// cinatra#3092: the read-only compositions hand drizzle-cube a configuration
// that says `eagerLoad: true`, so no portlet of a read-only display takes the
// library's deferred (visibility-gated) loading road.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen: Array<Record<string, unknown>> = [];

vi.mock("drizzle-cube/client", () => ({
  DashboardProvider: (props: { config?: unknown; children?: unknown }) => {
    seen.push({
      config: props.config,
      editable: (props as { editable?: unknown }).editable,
      props,
    });
    return props.children ?? null;
  },
  DashboardGridSurface: () => null,
  CubeProvider: (props: { children?: unknown }) => props.children ?? null,
}));

import { ReadOnlyComposedDashboard, ReadOnlySinglePortlet } from "../read-only-composition";

const CONFIG = {
  portlets: [
    { id: "runs-by-agent", title: "Runs by agent", w: 6, h: 8, x: 0, y: 0 },
    { id: "other", title: "Other", w: 6, h: 8, x: 6, y: 0 },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

/** What the library must receive: the dashboard AND every portlet eager. */
function eager<T extends { portlets: object[] }>(config: T) {
  return { ...config, eagerLoad: true, portlets: config.portlets.map((p) => ({ ...p, eagerLoad: true })) };
}

beforeEach(() => {
  seen.length = 0;
});

describe("the read-only compositions hand drizzle-cube an eager configuration", () => {
  it("ReadOnlyComposedDashboard, with and without a data road", () => {
    renderToStaticMarkup(createElement(ReadOnlyComposedDashboard, { config: CONFIG as never }));
    renderToStaticMarkup(
      createElement(ReadOnlyComposedDashboard, {
        config: CONFIG as never,
        dataRoad: { road: "session", apiUrl: "/api/cube" },
      }),
    );
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      expect(call.config).toEqual(eager(CONFIG));
      expect(call.editable).toBe(false);
    }
  });

  it("ReadOnlySinglePortlet, still narrowed to the one named portlet", () => {
    renderToStaticMarkup(
      createElement(ReadOnlySinglePortlet, { config: CONFIG as never, portletId: "runs-by-agent" }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].config).toEqual(eager({ ...CONFIG, portlets: [CONFIG.portlets[0]] }));
  });

  it("overrides an explicit eagerLoad: false and leaves the caller's configuration unchanged", () => {
    const given = { ...CONFIG, eagerLoad: false };
    renderToStaticMarkup(createElement(ReadOnlyComposedDashboard, { config: given as never }));
    expect(seen[0].config).toEqual(eager(CONFIG));
    expect(given.eagerLoad).toBe(false);
  });

  it("makes a portlet that carries its own eagerLoad: false eager, without changing the caller's portlets", () => {
    // drizzle-cube reads the portlet's own flag before the dashboard's.
    const lazyPortlet = { ...CONFIG.portlets[0], eagerLoad: false };
    const given = { ...CONFIG, portlets: [lazyPortlet, CONFIG.portlets[1]] };
    renderToStaticMarkup(createElement(ReadOnlyComposedDashboard, { config: given as never }));
    renderToStaticMarkup(
      createElement(ReadOnlySinglePortlet, { config: given as never, portletId: "runs-by-agent" }),
    );
    const [dashboard, single] = seen.map((c) => c.config as { portlets: Array<{ eagerLoad?: unknown }> });
    expect(dashboard.portlets.map((p) => p.eagerLoad)).toEqual([true, true]);
    expect(single.portlets.map((p) => p.eagerLoad)).toEqual([true]);
    expect(lazyPortlet.eagerLoad).toBe(false);
    expect(given.portlets[0]).toBe(lazyPortlet);
    expect(CONFIG.portlets[1]).not.toHaveProperty("eagerLoad");
  });

  it("forwards no callback that receives a configuration, so an echo cannot persist the eager flags", () => {
    // Authored lazy opt-outs on the dashboard and on a portlet, plus callbacks a
    // caller may (wrongly) pass. drizzle-cube echoes the MOUNTED config through
    // onConfigChange/onSave; that copy says eagerLoad: true, which must never
    // reach a persisting callback.
    const authored = {
      ...CONFIG,
      eagerLoad: false,
      portlets: [{ ...CONFIG.portlets[0], eagerLoad: false }, CONFIG.portlets[1]],
    };
    const onConfigChange = vi.fn();
    const onSave = vi.fn();
    const onPortletRefresh = vi.fn();
    const extra = { config: authored as never, onConfigChange, onSave, onPortletRefresh };
    renderToStaticMarkup(createElement(ReadOnlyComposedDashboard, extra as never));
    renderToStaticMarkup(createElement(ReadOnlySinglePortlet, { ...extra, portletId: "runs-by-agent" } as never));
    expect(seen).toHaveLength(2);
    for (const call of seen) {
      const props = call.props as {
        config: unknown;
        onConfigChange?: (c: unknown) => void;
        onSave?: (c: unknown) => void;
        onPortletRefresh?: unknown;
      };
      // The simulated provider echo: whatever the provider was handed, if it
      // was handed a callback, it calls it with the mounted config.
      props.onConfigChange?.(props.config);
      props.onSave?.(props.config);
      expect(props).not.toHaveProperty("onConfigChange");
      expect(props).not.toHaveProperty("onSave");
      // A callback that carries no configuration is untouched.
      expect(props.onPortletRefresh).toBe(onPortletRefresh);
    }
    expect(onConfigChange).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    // The caller's authored flags are unchanged.
    expect(authored.eagerLoad).toBe(false);
    expect(authored.portlets[0].eagerLoad).toBe(false);
  });
});
