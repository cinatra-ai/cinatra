import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { createMetricUsagePrimitiveHandlers, daysSchema } from "./handlers";

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "metric_usage_events": {
    description: "Get daily token usage time-series (input and output tokens per day). Accepts optional days parameter (7, 30, or 90; default 30).",
    inputSchema: daysSchema,
  },
  "metric_usage_summary": {
    description: "Get token usage summary broken down by provider (total input, output, and call count). Accepts optional days parameter (7, 30, or 90; default 30).",
    inputSchema: daysSchema,
  },
};

export function registerMetricUsagePrimitives(server: McpRuntimeToolServer) {
  const handlers = createMetricUsagePrimitiveHandlers();

  for (const [name, handler] of Object.entries(handlers)) {
    const meta = TOOL_META[name] ?? { description: name, inputSchema: z.object({}).passthrough() };
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
          actor: { actorType: "model", source: "agent" },
          mode: "agentic",
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: Array.isArray(result) ? { items: result } : typeof result === "object" && result !== null ? (result as Record<string, unknown>) : { result },
        };
      }) as any,
    );
  }
}
