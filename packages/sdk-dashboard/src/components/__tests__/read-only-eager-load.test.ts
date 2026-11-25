// cinatra#3092: the read-only compositions hand drizzle-cube a configuration
// that says `eagerLoad: true`, so no portlet of a read-only display takes the
// library's deferred (visibility-gated) loading road.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const seen: Array<Record<string, unknown>> = [];

vi.mock("drizzle-cube/client", () => ({
  DashboardProvider: (props: { config?: unknown; children?: unknown }) => {
    seen.push({ config: props.config, editable: (props as { editable?: unknown }).editable });
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
      expect(call.config).toEqual({ ...CONFIG, eagerLoad: true });
      expect(call.editable).toBe(false);
    }
  });

  it("ReadOnlySinglePortlet, still narrowed to the one named portlet", () => {
    renderToStaticMarkup(
      createElement(ReadOnlySinglePortlet, { config: CONFIG as never, portletId: "runs-by-agent" }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].config).toEqual({ ...CONFIG, portlets: [CONFIG.portlets[0]], eagerLoad: true });
  });

  it("overrides an explicit eagerLoad: false and leaves the caller's configuration unchanged", () => {
    const given = { ...CONFIG, eagerLoad: false };
    renderToStaticMarkup(createElement(ReadOnlyComposedDashboard, { config: given as never }));
    expect(seen[0].config).toEqual({ ...CONFIG, eagerLoad: true });
    expect(given.eagerLoad).toBe(false);
  });
});
