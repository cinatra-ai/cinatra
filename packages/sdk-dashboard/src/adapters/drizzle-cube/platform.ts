/**
 * Single-source dashboards cube platform.
 *
 * The HTTP cubejs route at
 * `src/app/api/dashboards/cubejs-api/v1/[...endpoint]/route.ts` and the
 * MCP cube tools at `packages/dashboards/src/mcp-cubes/` share one
 * `SemanticLayerCompiler` with shared cube registrations. That prevents
 * drift as the cube catalog grows.
 *
 * `createDashboardCubesPlatform` constructs the `SemanticLayerCompiler`
 * ONCE and exposes BOTH transports' Cinatra-shaped surfaces. Same layer,
 * same cube list, same security context typing — no drift.
 *
 * The drizzle-cube `SemanticLayerCompiler` type stays inside this
 * directory — neither the `AdapterHandle` nor the `CinatraCubeMcpTools`
 * consumer surfaces expose it.
 */
import "server-only";
import {
  createDrizzleSemanticLayer,
  type SemanticLayerCompiler,
} from "drizzle-cube/server";

import { _buildAdapterFromLayer, type AdapterHandle } from "./create-adapter";
import {
  _buildMcpToolsFromLayer,
  type CinatraCubeMcpTools,
  type LayerMcpToolsOptions,
} from "./mcp-tools";
import type { RegisteredCube } from "./types";

export type DashboardCubesPlatformOptions = {
  /** Drizzle database handle (passed through to drizzle-cube/server). */
  readonly drizzle: unknown;
  /** Drizzle schema (tables, relations). Optional but typical. */
  readonly schema?: unknown;
  /** Cubes to register on the shared semantic layer. */
  readonly cubes: ReadonlyArray<RegisteredCube>;
};

export type DashboardCubesPlatform = {
  /** Cinatra adapter handle for HTTP cubejs-style queries. */
  readonly adapter: AdapterHandle;
  /**
   * Build a Cinatra MCP cube tools bridge against the same shared
   * `SemanticLayerCompiler`. The `getSecurityContext` callback is passed
   * per-call from the host so per-request identity stays dynamic.
   */
  readonly getMcpTools: (opts: LayerMcpToolsOptions) => CinatraCubeMcpTools;
};

/**
 * Build the dashboards cube platform.
 *
 * The cube registration runs once: `layer.registerCube` is called for each
 * `RegisteredCube` BEFORE either transport sees the layer. Consumers can
 * mutate neither the layer nor the cube list.
 */
export function createDashboardCubesPlatform(
  opts: DashboardCubesPlatformOptions,
): DashboardCubesPlatform {
  const layer: SemanticLayerCompiler = createDrizzleSemanticLayer({
    drizzle: opts.drizzle as never,
    schema: opts.schema,
  });
  for (const reg of opts.cubes) {
    layer.registerCube(reg.dcCube);
  }
  return {
    adapter: _buildAdapterFromLayer(layer, opts.cubes),
    getMcpTools: (mcpOpts) =>
      _buildMcpToolsFromLayer(layer, opts.cubes, mcpOpts),
  };
}
