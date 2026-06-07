import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AGENTS_DEFAULT_CONFIG } from "../components/seed-configs/agents-default";
import { AgentsDashboardGrid } from "../components/agents-dashboard-grid";

vi.mock("drizzle-cube/client", () => ({
  DashboardGrid: () => "DRIZZLE_GRID_MARKER",
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
