/**
 * MCP-side bridge into the shared `DashboardCubesPlatform`.
 *
 * Both transports (HTTP cubejs route + MCP cube tools) resolve through
 * `getDashboardCubesPlatform()`, sharing one semantic layer and one cube
 * list. This keeps custom cubes and async AI-generated dashboards visible
 * through the same catalog, without divergence as the catalog grows.
 *
 * `getSecurityContext` is still a per-invocation closure — drizzle-cube
 * calls it inside `cubeTools.handle()` so identity is resolved from the
 * MCP transport's AsyncLocalStorage at call time, never frozen.
 */
import "server-only";

import { getDashboardCubesPlatform, __resetDashboardCubesPlatformForTests } from "@cinatra-ai/dashboards/cubes-platform";
import type { CinatraCubeMcpTools } from "@cinatra-ai/sdk-dashboard/adapters/drizzle-cube";
import type { SecurityContext } from "@cinatra-ai/sdk-dashboard";

declare global {
  // eslint-disable-next-line no-var
  var __cinatraDashboardsMcpCubeTools: CinatraCubeMcpTools | undefined;
}

export type McpCubeToolsOptions = {
  /**
   * Per-invocation identity resolver. Called by drizzle-cube during
   * `cubeTools.handle()`. Must read identity from the MCP transport's
   * `AsyncLocalStorage` at call time — never capture identity statically.
   */
  readonly getSecurityContext: (meta?: unknown) => SecurityContext | Promise<SecurityContext>;
};

/**
 * Build (or reuse) the MCP-side cube tools bridge against the shared
 * platform's `SemanticLayerCompiler`. The bridge instance is cached on
 * `globalThis` to survive HMR; the `getSecurityContext` callback is
 * captured ONCE at first construction — the host module must pass a
 * dynamic closure that re-reads ALS on every invocation.
 */
export function getMcpCubeTools(opts: McpCubeToolsOptions): CinatraCubeMcpTools {
  if (globalThis.__cinatraDashboardsMcpCubeTools) {
    return globalThis.__cinatraDashboardsMcpCubeTools;
  }
  const platform = getDashboardCubesPlatform();
  const tools = platform.getMcpTools({
    getSecurityContext: opts.getSecurityContext,
    toolPrefix: "dashboards_cube_",
    // Omit `tools` so drizzle-cube's full default (`discover`, `validate`,
    // `load`, `chart`) takes effect. `app: true` is the default in
    // `createDrizzleCubeMcpTools` — registers the MCP App resource that
    // MCP-Apps-aware clients render alongside `chart`.
  });
  globalThis.__cinatraDashboardsMcpCubeTools = tools;
  return tools;
}

/** Test-only — clear the global singletons so a fresh build is forced. */
export function __resetMcpCubeToolsForTests(): void {
  globalThis.__cinatraDashboardsMcpCubeTools = undefined;
  __resetDashboardCubesPlatformForTests();
}
