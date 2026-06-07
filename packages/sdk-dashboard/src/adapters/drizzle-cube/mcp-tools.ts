/**
 * Bridge between `drizzle-cube/mcp` and Cinatra's MCP server registry.
 *
 * The whole point of the adapter directory is that the rest of the repo
 * never imports drizzle-cube directly. This file is the ONLY place in the
 * monorepo permitted to import `drizzle-cube/mcp` (ESLint Layer-3 carve-
 * out). Consumers get Cinatra-typed `{ definitions, handle, handles,
 * toolNames }` and never see `drizzle-cube/*` types.
 *
 * Why a wrapper instead of reimplementing the cube tools ourselves:
 *
 *   - drizzle-cube keeps `discover` / `validate` / `load` as the source of
 *     truth — versions 0.5.4+ embed query-language reference + date-filter
 *     guidance inside the `discover` payload, and 0.5.5+ surfaces the
 *     generated SQL on validate / load. Reimplementing would mean
 *     re-shipping those LLM-facing improvements ourselves.
 *   - The drizzle-cube wire shape evolves on minor bumps; pinning the
 *     bridge to one library version through `json-schema-to-zod` and
 *     this small shim is cheaper than maintaining a parallel
 *     implementation.
 *
 * Layer construction is split out into `_buildMcpToolsFromLayer` so
 * `platform.ts` can share ONE `SemanticLayerCompiler` between the HTTP
 * cubejs route and the MCP tools. `createDrizzleCubeMcpTools` retains its
 * prior shape for callers that only want the MCP transport.
 */
import "server-only";
import {
  getCubeTools,
  type GetCubeToolsOptions,
  type MCPToolDefinition,
  type MCPToolResult,
} from "drizzle-cube/mcp";
import {
  createDrizzleSemanticLayer,
  type SecurityContext as DCSecurityContext,
  type SemanticLayerCompiler,
} from "drizzle-cube/server";
import type { z } from "zod";

import type { SecurityContext } from "../../types/index";
import type { RegisteredCube } from "./types";
import { jsonSchemaToZod, type JsonSchemaNode } from "./json-schema-to-zod";

/** A drizzle-cube MCP tool, with its inputSchema converted to Zod. */
export type CinatraCubeToolDef = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  /**
   * Tool metadata passed through from drizzle-cube. The `chart` tool
   * carries `_meta.ui.resourceUri` pointing at the MCP App visualization
   * resource that MCP-Apps-aware clients (Claude Desktop, Claude.ai)
   * mount inline. Required for the chart UX — without it, the client has
   * no way to find the visualization HTML payload.
   */
  readonly _meta?: Readonly<Record<string, unknown>>;
};

export type CinatraCubeMcpResult = {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly structuredContent: Readonly<Record<string, unknown>>;
  readonly isError: boolean;
};

/**
 * Static MCP resource emitted by drizzle-cube's `getCubeTools`. The
 * shape mirrors the MCP spec `resources/list` entry plus the inline
 * `text` content used by `resources/read`. Cinatra surfaces these via
 * `McpRuntimeToolServer.registerResource` so MCP-Apps-aware clients can
 * load them by URI.
 */
export type CinatraCubeMcpResource = {
  readonly uri: string;
  readonly name: string;
  readonly mimeType: string;
  readonly description?: string;
  readonly text: string;
};

export type CinatraCubeMcpTools = {
  readonly definitions: ReadonlyArray<CinatraCubeToolDef>;
  /** Dispatch a tool call. Returns a Cinatra-shaped MCP response. */
  handle(name: string, args: unknown): Promise<CinatraCubeMcpResult>;
  /** Whether this bridge handles the given (prefixed) name. */
  handles(name: string): boolean;
  /** Names of all registered tools, prefixed. */
  toolNames: ReadonlyArray<string>;
  /**
   * Static resources to register on the Cinatra MCP server. With
   * `app: true` (the default for the chart tool), drizzle-cube emits
   * the visualization HTML payload as a resource here.
   */
  readonly resources: ReadonlyArray<CinatraCubeMcpResource>;
};

export type DrizzleCubeMcpToolsOptions = {
  /** Drizzle database handle (passed through to drizzle-cube/server). */
  readonly drizzle: unknown;
  /** Drizzle schema (tables, relations). Optional but typical. */
  readonly schema?: unknown;
  /** Cubes to register; same shape consumed by `createDrizzleCubeAdapter`. */
  readonly cubes: ReadonlyArray<RegisteredCube>;
  /**
   * Per-invocation security context resolver. Called by drizzle-cube each
   * time the `load` tool runs. Must be dynamic — read identity from the
   * MCP transport's AsyncLocalStorage at call time, not at construction.
   */
  readonly getSecurityContext: (meta?: unknown) => SecurityContext | Promise<SecurityContext>;
  /** Default 'dashboards_cube_'. */
  readonly toolPrefix?: string;
  /**
   * Default: drizzle-cube's full set — `discover`, `validate`, `load`,
   * `chart`. `chart` exists since drizzle-cube 0.4.50 (the TS type for
   * `GetCubeToolsOptions.tools` is stale and only lists the original
   * three, but the runtime accepts `'chart'`).
   */
  readonly tools?: ReadonlyArray<"discover" | "validate" | "load" | "chart">;
  /**
   * Enable drizzle-cube's MCP App — exposes an interactive chart
   * visualization resource that MCP-Apps-aware clients (Claude Desktop,
   * Claude.ai) render alongside the `chart` tool result. Default true
   * for the LLM-rendering UX. Text-only clients ignore the resource
   * transparently. See drizzle-cube 0.4.45 release notes.
   */
  readonly app?: boolean;
};

/** Layer-only slice — what `_buildMcpToolsFromLayer` consumes. */
export type LayerMcpToolsOptions = Pick<
  DrizzleCubeMcpToolsOptions,
  "getSecurityContext" | "toolPrefix" | "tools"
> & {
  /** Optional MCP App passthrough — forwarded to drizzle-cube's `app` flag. */
  readonly app?: boolean;
};

/**
 * Build a Cinatra-shaped MCP cube tools bridge against a pre-built
 * `SemanticLayerCompiler`. Used by `platform.ts` to share one layer with
 * the HTTP cubejs route. Caller is responsible for `layer.registerCube` on
 * each cube BEFORE calling this.
 *
 * Internal API — exposed for platform composition only. Underscore prefix
 * signals "do not import outside the adapter directory".
 */
export function _buildMcpToolsFromLayer(
  layer: SemanticLayerCompiler,
  _cubes: ReadonlyArray<RegisteredCube>,
  opts: LayerMcpToolsOptions,
): CinatraCubeMcpTools {
  const cubeTools = getCubeTools({
    semanticLayer: layer,
    // Cast: drizzle-cube SecurityContext is `[k: string]: unknown` (widened
    // intentionally); Cinatra's typed SecurityContext satisfies that shape.
    getSecurityContext: opts.getSecurityContext as GetCubeToolsOptions["getSecurityContext"] as (
      meta?: unknown,
    ) => DCSecurityContext | Promise<DCSecurityContext>,
    toolPrefix: opts.toolPrefix ?? "dashboards_cube_",
    // Cast: drizzle-cube's TS type lists 3 tools but the runtime emits
    // `chart` as a 4th by default since 0.4.50 (verified against
    // `mcp-tools.js` source). Passing `undefined` lets drizzle-cube use
    // its own default array which already includes `chart`.
    tools: opts.tools as GetCubeToolsOptions["tools"],
    app: opts.app ?? true,
  });

  const definitions: CinatraCubeToolDef[] = cubeTools.definitions.map((d: MCPToolDefinition) => {
    // drizzle-cube attaches `_meta` to the chart tool definition with the
    // `ui.resourceUri` pointing at the MCP App visualization payload —
    // preserve it so MCP-Apps-aware clients can mount the visualization.
    const meta = (d as MCPToolDefinition & { _meta?: Record<string, unknown> })._meta;
    return {
      name: d.name,
      description: d.description,
      inputSchema: jsonSchemaToZod(d.inputSchema as JsonSchemaNode),
      ...(meta ? { _meta: meta } : {}),
    };
  });

  // Pass-through drizzle-cube's static MCP resources. With `app: true` the
  // bundle includes the `ui://drizzle-cube/visualization.html` MCP App
  // payload that backs the `chart` tool's interactive rendering.
  const resources: CinatraCubeMcpResource[] = (cubeTools.resources ?? [])
    .filter((r: { uri?: string; name?: string; text?: string; mimeType?: string }) =>
      typeof r.uri === "string" &&
      typeof r.name === "string" &&
      typeof r.text === "string" &&
      typeof r.mimeType === "string",
    )
    .map((r) => ({
      uri: r.uri as string,
      name: r.name as string,
      mimeType: r.mimeType as string,
      description: (r as { description?: string }).description,
      text: r.text as string,
    }));

  return {
    definitions,
    async handle(name, args) {
      const result: MCPToolResult = await cubeTools.handle(name, args);
      // drizzle-cube emits a single text block containing JSON.stringify of
      // either the success body or an error envelope. Decode to expose
      // structuredContent — Cinatra clients (chat-mcp, claude-code) lean on
      // structuredContent for typed access.
      const text = result.content?.[0]?.text ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
      const structuredContent =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { result: parsed };
      return {
        content: [{ type: "text", text }],
        structuredContent,
        isError: result.isError === true,
      };
    },
    handles: (name) => cubeTools.handles(name),
    toolNames: cubeTools.toolNames,
    resources,
  };
}

/**
 * Build the Cinatra-shaped cube MCP tools. Constructs an internal
 * `SemanticLayerCompiler`, registers all cubes, then bridges
 * `getCubeTools` into Cinatra's MCP registry surface.
 *
 * The returned `definitions` array carries Zod inputSchemas that the
 * Cinatra MCP server's `registerTool` expects. `handle` parses the JSON
 * text payload drizzle-cube emits and re-shapes it as Cinatra's
 * `{ content, structuredContent, isError }`.
 */
export function createDrizzleCubeMcpTools(
  opts: DrizzleCubeMcpToolsOptions,
): CinatraCubeMcpTools {
  const layer = createDrizzleSemanticLayer({
    drizzle: opts.drizzle as never,
    schema: opts.schema,
  });
  for (const reg of opts.cubes) {
    layer.registerCube(reg.dcCube);
  }
  return _buildMcpToolsFromLayer(layer, opts.cubes, {
    getSecurityContext: opts.getSecurityContext,
    toolPrefix: opts.toolPrefix,
    tools: opts.tools,
    app: opts.app,
  });
}
