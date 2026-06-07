import "server-only";

import { registerDashboardPrimitives } from "../mcp/registry";

/**
 * Cinatra MCP module factory for the dashboards platform.
 *
 * Registers dashboard MCP tools for read-only access, dashboard writes,
 * dashboard archival, cube operations, and AI-assisted dashboard workflows.
 *
 * The MCP count cap is asserted by
 * `packages/dashboards/src/__tests__/mcp-cap.test.ts`.
 */
export function createDashboardsModule() {
  return {
    registerCapabilities: registerDashboardPrimitives,
  };
}
