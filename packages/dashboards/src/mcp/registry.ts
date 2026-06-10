import "server-only";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import type { ZodTypeAny } from "zod";

import { createDashboardPrimitiveHandlers } from "./handlers";
import {
  dashboardsArchiveSchema,
  dashboardsCreateSchema,
  dashboardsGetSchema,
  dashboardsListSchema,
  dashboardsPublishSchema,
  dashboardsUpdateSchema,
} from "./schemas";

// Typed as `Record<string, { description; inputSchema }>` so
// scripts/build-authz-inventory.mjs picks the primitive names up via the
// TOOL_META_BLOCK regex. Without the Record annotation the scanner silently
// skips the family and `dashboards_*` calls get denied at runtime by the
// MCP-boundary check as `unclassified_primitive`.
const TOOL_META: Record<string, { description: string; inputSchema: ZodTypeAny }> = {
  // Read tools.
  dashboards_list: {
    description:
      "List dashboards accessible to the caller. Filters by owner level / owner id / visibility / status / search. Inactive (archived, generation_failed) dashboards are excluded unless `status` is explicitly set.",
    inputSchema: dashboardsListSchema,
  },
  dashboards_get: {
    description:
      "Fetch a single dashboard by id, including its revision history summary. Returns { dashboard, revisions } on success; { error: {code, message} } on not_found / forbidden / unauthorized.",
    inputSchema: dashboardsGetSchema,
  },
  // Write tools.
  dashboards_create: {
    description:
      "Create a new dashboard. Validates DashboardConfig (Zod) and writes an audit_events row inside the same transaction. Returns { dashboard } on success; { error } with code forbidden / invalid_config / internal_error.",
    inputSchema: dashboardsCreateSchema,
  },
  dashboards_update: {
    description:
      "Update a dashboard (name / description / config / configVersion / visibility). Bumps `dashboard_version` for cache invalidation. Returns { dashboard } on success; { error } with code forbidden / not_found / invalid_config / internal_error.",
    inputSchema: dashboardsUpdateSchema,
  },
  dashboards_publish: {
    description:
      "Publish a dashboard. Snapshots the current draft config into dashboard_revisions (revision_number = max+1, computed atomically under SELECT FOR UPDATE) and flips status to 'published'. Returns { dashboard }.",
    inputSchema: dashboardsPublishSchema,
  },
  dashboards_archive: {
    description:
      "Soft-delete (archive) a dashboard. Transitions status to 'archived' and stamps archived_at. Returns { dashboard }. This primitive does not hard-delete dashboards.",
    inputSchema: dashboardsArchiveSchema,
  },
};

/**
 * Register dashboards primitives. The handler-shape pattern mirrors
 * packages/lists/src/mcp/registry.ts: the MCP transport handler populates
 * `mcpRequestContextStorage` from the active better-auth session, and we
 * read orgId + userId from there to build the PrimitiveInvocationRequest
 * envelope passed to each handler.
 */
export function registerDashboardPrimitives(server: McpRuntimeToolServer): void {
  const handlers = createDashboardPrimitiveHandlers();
  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name as keyof typeof TOOL_META];
    if (!meta) continue;
    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      (async (input: unknown) => {
        // Read actor context from the MCP request ALS. Mirrors
        // packages/lists/src/mcp/registry.ts.
        const requestCtx = mcpRequestContextStorage.getStore();
        const orgId = requestCtx?.orgId ?? null;
        const userId = requestCtx?.userId ?? null;

        // Propagate platformRole from the MCP request context. Without it,
        // cookie-authenticated admin actors lose their role on the kernel
        // boundary; packages/objects/src/mcp/registry.ts carries the
        // canonical explanation and root-cause notes.
        const platformRole = requestCtx?.platformRole;
        const actorBase: Record<string, unknown> = {
          actorType: platformRole ? "human" : "model",
          source: "agent",
        };
        if (userId) actorBase.userId = userId;
        if (orgId) actorBase.orgId = orgId;
        if (platformRole) actorBase.platformRole = platformRole;
        // Transport-resolved org-membership role — coherent with the
        // userId/orgId stamped from the same request-context frame above.
        if (requestCtx?.orgRole) actorBase.orgRole = requestCtx.orgRole;

        const result = await handler({
          primitiveName: name,
          input,
          actor: actorBase as unknown as Parameters<typeof handler>[0]["actor"],
          mode: "agentic",
        } as Parameters<typeof handler>[0]);

        const resolved = result === undefined ? null : result;
        return {
          content: [{ type: "text", text: JSON.stringify(resolved) }],
          structuredContent:
            Array.isArray(resolved)
              ? { items: resolved }
              : typeof resolved === "object" && resolved !== null
                ? (resolved as Record<string, unknown>)
                : { result: resolved },
        };
      }) as never,
    );
  }
}
