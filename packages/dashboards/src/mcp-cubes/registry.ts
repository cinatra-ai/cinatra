/**
 * MCP registry for the dashboard-cube semantic-query primitives.
 *
 * Mirrors `packages/lists/src/mcp/registry.ts`: the MCP server transport
 * has already populated `mcpRequestContextStorage` from the active
 * better-auth session / OAuth Bearer token, and our handler just dispatches
 * — auth is the transport's job, not ours.
 *
 * Why we read `def.inputSchema` (the whole `ZodObject`) and not
 * `def.inputSchema.shape`: the MCP SDK's `registerTool` accepts a
 * `StandardSchema` object — Cinatra's other modules pass whole Zod
 * schemas (see `packages/lists/src/mcp/registry.ts:registerListPrimitives`).
 * Passing `.shape` would type-fail and at runtime break the SDK's tool
 * validation path.
 */
import "server-only";

import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

import { createDashboardCubeMcpHandlers } from "./handlers";
import { getMcpCubeTools } from "./cubes-singleton";
import {
  listAccessibleOrgIdsForUser,
  readUserIsPlatformAdmin,
} from "@/lib/better-auth-db";
import { resolveDashboardCubeIdentity } from "./handlers";
import { buildDashboardCubeMcpSecurityContext } from "./security-context";

// Object-valued (not string-valued) so scripts/build-authz-inventory.mjs
// picks the primitive names up via the TOOL_META_KEY regex (which expects
// `key: {` after each entry). String-valued shape was the original drift
// that caused dashboards_cube_* to be silently missing from the authz
// inventory and rejected at runtime as `unclassified_primitive`.
const CUBE_TOOL_META: Record<string, { description: string }> = {
  dashboards_cube_discover: {
    description:
      "Discover dashboards cubes by topic or intent. Returns cube definitions (dimensions, measures, joins) plus the drizzle-cube query-language reference. ALWAYS call this BEFORE dashboards_cube_validate / dashboards_cube_load when authoring a new query.",
  },
  dashboards_cube_validate: {
    description:
      "Validate a CubeQuery without executing it. Returns the parsed query, any auto-corrections, and (when auth is available) the generated SQL. Use to confirm correctness before running dashboards_cube_load.",
  },
  dashboards_cube_load: {
    description:
      "Execute a CubeQuery against the caller's accessible data and return rows. Read-only. Tenant-isolated — rows are filtered at the SQL predicate layer to runs the caller personally triggered OR runs in ANY organization the caller is a member of (see SecurityContext.accessibleOrgIds). The query language is drizzle-cube's standard CubeQuery (see the discover response for full reference).",
  },
  dashboards_cube_chart: {
    description:
      "Execute a CubeQuery (same shape and same multi-org tenant isolation as dashboards_cube_load) and return an interactive chart visualization via the MCP Apps protocol. MCP-Apps-aware clients (Claude Desktop, Claude.ai) render the chart inline; text-only clients see the JSON payload. Use this when the answer is better shown than told (time series, comparisons, top-N).",
  },
};

/**
 * Register dashboard-cube MCP primitives.
 *
 * The handlers are constructed BEFORE registration so the underlying
 * `CinatraCubeMcpTools` bridge is cached on `globalThis` — registering
 * tools after the bridge is built ensures the Zod inputSchemas are
 * derived from the live drizzle-cube tool definitions, not stale ones.
 */
export function registerDashboardCubePrimitives(server: McpRuntimeToolServer): void {
  // Build the bridge first — captures the (dynamic) getSecurityContext
  // closure and ensures definitions are available for the
  // server.registerTool call below.
  const tools = getMcpCubeTools({
    getSecurityContext: async () => {
      const identity = resolveDashboardCubeIdentity();
      if (!identity) {
        throw new Error(
          "dashboards_cube_*: missing user/organization identity in MCP request context",
        );
      }
      // Widen accessibleOrgIds to every org the user belongs to AND
      // decorate isPlatformAdmin (DB role lookup) for the llm_usage cube
      // gate. Uses the SAME shared helper as handlers.ts so this second
      // closure site can never drift from the first. drizzle-cube's
      // getSecurityContext accepts a Promise; the membership + role queries
      // run inside the same ALS context as identity resolution.
      const sc = await buildDashboardCubeMcpSecurityContext(
        identity,
        listAccessibleOrgIdsForUser,
        readUserIsPlatformAdmin,
      );
      if (!sc) {
        throw new Error(
          "dashboards_cube_*: failed to build SecurityContext from identity",
        );
      }
      return sc;
    },
  });

  const handlers = createDashboardCubeMcpHandlers();
  const handlerMap = handlers as Record<string, (input: unknown) => Promise<unknown>>;

  for (const def of tools.definitions) {
    const handler = handlerMap[def.name];
    if (!handler) continue;
    const description = CUBE_TOOL_META[def.name]?.description ?? def.description;
    // drizzle-cube attaches `_meta` to the `chart` tool with
    // `ui.resourceUri` pointing at the MCP App visualization payload.
    // The MCP SDK forwards `_meta` to clients through the underlying
    // `Tool` shape — we pass it through via the SDK's
    // annotations/meta-friendly options (any-cast to bypass the SDK's
    // narrow type until upstream exposes a typed slot).
    server.registerTool(
      def.name,
      {
        title: def.name,
        description,
        // Pass the whole Zod object — Cinatra's other modules do the same
        // (see packages/lists/src/mcp/registry.ts:registerListPrimitives).
        // The MCP SDK accepts a StandardSchema (Zod implements it).
        inputSchema: def.inputSchema,
        ...(def._meta ? { _meta: def._meta } : {}),
      } as never,
      (async (input: unknown) => {
        // Defense-in-depth ALS re-entry. The outer MCP-runtime wrapper at
        // packages/mcp-server/src/index.tsx:836 already wraps `cb` in
        // mcpRequestContextStorage.run, but the drizzle-cube dispatch chain
        // (tools.handle → getSecurityContext) appears to drop the ALS frame
        // for cube primitives specifically — `dashboards_cube_load` was
        // failing with "missing user/organization identity in MCP request
        // context" while sibling list/get reads on the same frame succeeded.
        // Snapshot the current frame here and re-enter it around
        // `handler(input)` so getSecurityContext sees the actor identity
        // even if drizzle-cube has an internal Promise/timer that breaks
        // ALS propagation.
        const ctx = mcpRequestContextStorage.getStore();
        const result = (await (ctx
          ? mcpRequestContextStorage.run(ctx, () => handler(input))
          : handler(input))) as {
          content: ReadonlyArray<{ type: "text"; text: string }>;
          structuredContent: Readonly<Record<string, unknown>>;
          isError: boolean;
        };
        return {
          content: result.content as Array<{ type: "text"; text: string }>,
          structuredContent: result.structuredContent as Record<string, unknown>,
          isError: result.isError,
        };
      }) as never,
    );
  }

  // Register drizzle-cube's static MCP resources, including the
  // `ui://drizzle-cube/visualization.html` MCP App payload that backs the
  // `chart` tool. Without this, MCP-Apps-aware clients can't render the
  // chart inline even when the tool's `_meta` points at the resource URI.
  for (const resource of tools.resources) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            text: resource.text,
          },
        ],
      }),
    );
  }
}
