import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AGENTS_DEFAULT_CONFIG } from "../components/seed-configs/agents-default";
import { AgentsDashboardGrid } from "../components/agents-dashboard-grid";

// `AgentsDashboardGrid` renders `<ComposedDashboard>` (the composable
// drizzle-cube pieces) once hydrated. Stub the pieces it pulls from
// drizzle-cube/client so the provider — the composition's root — emits a
// marker: the pre-hydration server pass must render the placeholder and
// never reach it.
vi.mock("drizzle-cube/client", () => ({
  DashboardProvider: () => "DRIZZLE_GRID_MARKER",
  DashboardFilterBar: () => null,
  DashboardGridSurface: () => null,
  DashboardModals: () => null,
  useCubeFeatures: () => ({ features: {}, dashboardModes: ["grid"] }),
  useDashboardContext: () => {
    throw new Error("useDashboardContext outside DashboardProvider");
  },
  useDashboardStore: () => false,
}));

describe("AgentsDashboardGrid hydration", () => {
  it("server-renders a stable placeholder before mounting drizzle-cube", () => {
    const html = renderToString(
      React.createElement(AgentsDashboardGrid, {
        initialConfig: AGENTS_DEFAULT_CONFIG,
        editable: true,
        onSave: async () => {},
      }),
    );

    expect(html).toContain("Loading dashboard");
    expect(html).not.toContain("DRIZZLE_GRID_MARKER");
  });
});
