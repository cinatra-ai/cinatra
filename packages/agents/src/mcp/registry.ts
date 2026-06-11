import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { createAgentBuilderPrimitiveHandlers, createAgentsPrimitiveHandlers } from "./handlers";
import { AGENT_BUILDER_TOOL_META, AGENTS_TOOL_META } from "./schemas";
import { registerPublishedAgentTools } from "./agent-tools-registry";
import { registerAgentBuilderDiscovery } from "./discovery";

export { AGENT_BUILDER_TOOL_META } from "./schemas";

/**
 * Bridges A2A-authenticated SDK context
 * (mcpRequestContextStorage.a2aActorContext) into the loose actor envelope
 * handlers receive. Returns actorType:'a2a' branch when a2aActorContext is
 * present, else actorType:'model' fallback.
 *
 * Trust boundary: a2aActorContext is ONLY written by src/app/api/a2a/route.ts
 * after verifyA2AAccessToken succeeds (see auth-policy.ts:15). Never trust
 * client-supplied scopes.
 */
function buildActorFromMcpContext(): Record<string, unknown> {
  const requestCtx = mcpRequestContextStorage.getStore();
  const a2a = requestCtx?.a2aActorContext;
  const userId = a2a?.userId ?? requestCtx?.userId ?? null;
  // Forward the cookie-session-derived platformRole into the
  // actor envelope so admin-gated handlers (e.g. agent_source_publish) can
  // authorise without re-reading cookies. Stamped only when the transport
  // resolved a session (cookie-authenticated MCP traffic); A2A and
  // bearer-only paths leave it undefined.
  const platformRole = requestCtx?.platformRole;
  // Forward the transport-resolved orgId so the non-A2A
  // (model) actor carries it for delegated/cookieless MCP. Without this a
  // hosted-MCP `agent_run` relayed by OpenAI under the delegated chat-user
  // token reaches handleAgentBuilderRun with no org (no cookie session
  // either) and fails with "Active organization required.".
  const orgId = requestCtx?.orgId ?? null;
  // Forward the transport-resolved org-membership role alongside orgId so
  // org-admin-gated decisions (e.g. connector `manage` authority via
  // checkConnectorAccess) evaluate natively instead of re-resolving the
  // membership row inside each gate. Stamped on the MODEL branch only: the
  // transport resolved it for ITS identity pair (requestCtx.userId/orgId),
  // while the a2a branch's identity comes from a2aActorContext — potentially
  // a different user/org — so stamping it there would cross identities.
  const orgRole = requestCtx?.orgRole;

  if (a2a) {
    return {
      actorType: "a2a",
      source: "a2a",
      ...(userId ? { userId } : {}),
      ...(a2a.orgId !== undefined ? { orgId: a2a.orgId } : {}),
      ...(a2a.clientId ? { clientId: a2a.clientId } : {}),
      ...(a2a.tokenScopes ? { tokenScopes: a2a.tokenScopes } : {}),
      ...(a2a.teamIds ? { teamIds: a2a.teamIds } : {}),
      ...(a2a.projectIds ? { projectIds: a2a.projectIds } : {}),
      // Forward projectGrants alongside projectIds
      // so the canonical resolver's output (owned ∪ accessed,
      // role-by-authority) survives the A2A→primitive carrier boundary.
      // projectIds is kept for back-compat consumers (auth-policy.ts
      // binary shortcuts at :198 / :490-491).
      ...(a2a.projectGrants ? { projectGrants: a2a.projectGrants } : {}),
      ...(platformRole ? { platformRole } : {}),
    };
  }

  return {
    actorType: "model",
    source: "agent",
    ...(userId ? { userId } : {}),
    ...(orgId ? { orgId } : {}),
    ...(platformRole ? { platformRole } : {}),
    // Coherent with the orgId spread above by construction — both come from
    // the same transport-written store frame.
    ...(orgRole ? { orgRole } : {}),
  };
}

export async function registerAgentBuilderPrimitives(server: McpRuntimeToolServer): Promise<void> {
  // MCP primitives are auto-registered via the loop below
  // (they appear in createAgentBuilderPrimitiveHandlers()):
  //   - agent_run_trigger_set     — configure side-effects gate
  //   - agent_run_trigger_get     — read trigger configuration
  //   - agent_run_trigger_delete  — remove trigger + cancel BullMQ job
  // No explicit server.registerTool() call is needed here — the existing
  // for-of pattern picks up every handler-map key and looks up its
  // schema/description in AGENT_BUILDER_TOOL_META.
  const agentsHandlers = createAgentsPrimitiveHandlers();
  const allToolMeta = { ...AGENTS_TOOL_META, ...AGENT_BUILDER_TOOL_META };
  const handlers = { ...agentsHandlers, ...createAgentBuilderPrimitiveHandlers() };

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = allToolMeta[name] ?? {
      description: name,
      inputSchema: z.object({}).passthrough(),
    };

    server.registerTool(
      name,
      {
        title: name,
        description: meta.description,
        inputSchema: meta.inputSchema,
      },
      (async (input: unknown) => {
        // Bridge A2A actor context for authenticated actor threading.
        // Trust boundary: a2aActorContext is ONLY written by src/app/api/a2a/route.ts
        // after verifyA2AAccessToken succeeds (see auth-policy.ts:15). When present,
        // build actorType:"a2a" so enforceRunAccess sees the originating user's
        // scopes/teams/projects rather than the bot's model identity.
        // mcp-run-access-denied fix: inject userId from MCP session context so
        // run.runBy is populated at creation time and the owner short-circuit
        // in enforceRunAccess fires on subsequent agent_run_get calls.
        // Mirrors the pattern in packages/objects/src/mcp/registry.ts:66-86.
        const actorBase = buildActorFromMcpContext();

        const result = await handler({
          primitiveName: name,
          input,
          actor: actorBase as any,
          mode: "agentic",
        });

        const baseContent = [{ type: "text" as const, text: JSON.stringify(result) }];
        const structuredContent =
          Array.isArray(result)
            ? { items: result }
            : typeof result === "object" && result !== null
              ? (result as Record<string, unknown>)
              : { result };

        // Render hints for HITL-adjacent tools only.
        // Guard: handlers return { error: ... } on failure; check shape before casting.
        // Guard: this _meta lives on the CALLBACK RETURN, not on the tool definition above.
        let renderMeta: Record<string, unknown> | undefined;
        if (
          name === "agent_run" &&
          result &&
          typeof result === "object" &&
          "runId" in result &&
          typeof (result as { runId: unknown }).runId === "string"
        ) {
          renderMeta = {
            "io.cinatra.render": {
              type: "agent-run",
              runId: (result as { runId: string }).runId,
              protocols: ["ag-ui", "a2ui"],
            },
          };
        } else if (
          name === "agent_run_get" &&
          result &&
          typeof result === "object" &&
          "id" in result &&
          "status" in result
        ) {
          const run = result as { id: string; status: string };
          renderMeta = {
            "io.cinatra.render": {
              type: "agent-run-status",
              runId: run.id,
              status: run.status,
              approvalRequired: run.status === "pending_approval",
            },
          };
        } else if (
          name === "agent_run_messages_list" &&
          result &&
          typeof result === "object" &&
          "runId" in result &&
          "runStatus" in result
        ) {
          const r = result as { runId: string; runStatus: string };
          renderMeta = {
            "io.cinatra.render": {
              type: "agent-run-messages",
              runId: r.runId,
              runStatus: r.runStatus,
            },
          };
        }

        return {
          content: baseContent,
          structuredContent,
          ...(renderMeta ? { _meta: renderMeta } : {}),
        };
      }) as any,
    );
  }

  // Register published agent templates as dynamic MCP tools
  await registerPublishedAgentTools(server);

  // Register cinatra:// resources + cinatra/getting-started prompt
  registerAgentBuilderDiscovery(server);
}
