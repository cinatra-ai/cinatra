import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import { createTriggerHandlers } from "./handlers";
import { runIdSchema, triggerConfigSetSchema } from "./schemas";

// Build the request actor envelope from the MCP request context.
function buildActorFromRequestCtx(): Record<string, unknown> {
  const ctx = mcpRequestContextStorage.getStore();
  const platformRole = ctx?.platformRole;
  const actor: Record<string, unknown> = {
    actorType: platformRole ? "human" : "model",
    source: "agent",
  };
  if (ctx?.userId) actor.userId = ctx.userId;
  if (ctx?.orgId) actor.orgId = ctx.orgId;
  if (platformRole) actor.platformRole = platformRole;
  return actor;
}

// ---------------------------------------------------------------------------
// Trigger primitive registration with the host MCP server.
//
// Mirrors the pattern used by skills/registry.ts and agents/mcp/registry.ts:
// build the handler map, look up per-tool schemas in TOOL_META, and register
// each one with the runtime tool server. Each callback constructs an
// agentic-mode actor envelope on invocation; auth is enforced by the
// underlying handler via actorContextFromRequest.
// ---------------------------------------------------------------------------

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  trigger_config_get: {
    description:
      "Read the current trigger configuration for an agent run (returns null if no trigger is set).",
    inputSchema: runIdSchema,
  },
  trigger_config_set: {
    description:
      "Create or update the trigger configuration for an agent run (immediate / scheduled / recurring). " +
      "Use ISO 8601 in UTC for scheduledAt and a 5-field cron expression for cronExpression.",
    inputSchema: triggerConfigSetSchema,
  },
  trigger_config_delete: {
    description:
      "Delete the trigger configuration for an agent run (removes the row and cancels any pending BullMQ job).",
    inputSchema: runIdSchema,
  },
};

export function registerTriggerPrimitives(server: McpRuntimeToolServer): void {
  const handlers = createTriggerHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? {
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
        const result = await handler({
          primitiveName: name,
          input,
          actor: buildActorFromRequestCtx() as Parameters<typeof handler>[0]["actor"],
          mode: "agentic",
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          structuredContent:
            Array.isArray(result)
              ? { items: result }
              : typeof result === "object" && result !== null
                ? (result as Record<string, unknown>)
                : { result },
        };
      }) as any,
    );
  }
}
