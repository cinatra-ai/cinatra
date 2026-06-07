/**
 * Public surface for the dashboard-cube MCP module.
 *
 * Exports the host-side factory that `src/lib/mcp-server.ts` registers
 * alongside the existing 24 MCP modules. The cube tools share the same
 * auth gate as everything else at `/api/mcp` — no new endpoint, no
 * second auth surface.
 */
import "server-only";

import { registerDashboardCubePrimitives } from "./registry";

export function createDashboardCubesMcpModule() {
  return {
    registerCapabilities: registerDashboardCubePrimitives,
  };
}

export { registerDashboardCubePrimitives } from "./registry";
export { createDashboardCubeMcpHandlers, resolveDashboardCubeIdentity } from "./handlers";
export { __resetMcpCubeToolsForTests, getMcpCubeTools } from "./cubes-singleton";
