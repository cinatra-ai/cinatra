import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  createWorkflowPrimitiveHandlers,
  type WorkflowHandlerDeps,
} from "./handlers";
import { WORKFLOW_TOOL_META } from "./schemas";

export { WORKFLOW_TOOL_META } from "./schemas";

/**
 * Bridge the transport-resolved request context into the loose actor envelope
 * handlers receive. orgId/userId/platformRole are stamped by the transport
 * (cookie session or delegated chat token); A2A adds teamIds/projectIds/orgRole.
 * Never trust client-supplied scopes — mirrors packages/agents/src/mcp/registry.ts.
 */
function buildActorFromMcpContext(): Record<string, unknown> {
  const ctx = mcpRequestContextStorage.getStore();
  const a2a = ctx?.a2aActorContext;
  const userId = a2a?.userId ?? ctx?.userId ?? null;
  const orgId = a2a?.orgId ?? ctx?.orgId ?? null;
  const platformRole = ctx?.platformRole;
  // Transport-resolved org-membership role (carried natively on the request
  // context). Stamped on the MODEL branch only: it was resolved for the
  // transport identity (ctx.userId/ctx.orgId), while the a2a branch identity
  // comes from a2aActorContext (potentially a different user/org) — stamping
  // it there would cross identities.
  const orgRole = ctx?.orgRole;
  if (a2a) {
    return {
      actorType: "a2a",
      source: "a2a",
      ...(userId ? { userId } : {}),
      ...(orgId ? { orgId } : {}),
      ...(a2a.teamIds ? { teamIds: a2a.teamIds } : {}),
      ...(a2a.projectIds ? { projectIds: a2a.projectIds } : {}),
      ...(platformRole ? { platformRole } : {}),
    };
  }
  return {
    actorType: "model",
    source: "agent",
    ...(userId ? { userId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(platformRole ? { platformRole } : {}),
    ...(orgRole ? { orgRole } : {}),
  };
}

export function registerWorkflowPrimitives(
  server: McpRuntimeToolServer,
  deps: WorkflowHandlerDeps = {},
): void {
  const handlers = createWorkflowPrimitiveHandlers(deps);
  for (const [name, handler] of Object.entries(handlers)) {
    const meta = WORKFLOW_TOOL_META[name] ?? {
      description: name,
      inputSchema: z.object({}).loose(),
    };
    server.registerTool(
      name,
      { title: name, description: meta.description, inputSchema: meta.inputSchema },
      (async (input: unknown) => {
        const actor = buildActorFromMcpContext();
        const result = await (handler as (r: { primitiveName: string; input: unknown; actor: unknown; mode: string }) => Promise<unknown>)({
          primitiveName: name,
          input,
          actor,
          mode: "agentic",
        });
        const content = [{ type: "text" as const, text: JSON.stringify(result) }];
        const structuredContent =
          typeof result === "object" && result !== null ? (result as Record<string, unknown>) : { result };
        // Workflow handoff render hint when the result carries a deep link.
        let renderMeta: Record<string, unknown> | undefined;
        if (
          result &&
          typeof result === "object" &&
          "workflowId" in result &&
          "deepLink" in result &&
          typeof (result as { workflowId?: unknown }).workflowId === "string"
        ) {
          const r = result as { workflowId: string; deepLink: string };
          renderMeta = {
            // surface was "gantt" before the built-in GANTT was removed
            // (cinatra#321); the deep link targets the workflow detail page.
            "io.cinatra.render": { type: "workflow", workflowId: r.workflowId, deepLink: r.deepLink, surface: "workflow" },
          };
        }
        return { content, structuredContent, ...(renderMeta ? { _meta: renderMeta } : {}) };
      }) as never,
    );
  }
}
