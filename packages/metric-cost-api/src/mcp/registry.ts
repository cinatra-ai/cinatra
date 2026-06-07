import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { createMetricCostPrimitiveHandlers, daysSchema, limitSchema, timeseriesSchema } from "./handlers";

const TOOL_META: Record<string, { description: string; inputSchema: z.ZodTypeAny }> = {
  "metric_cost_summary": {
    description: "Get all-time, monthly, and weekly LLM API cost summary including event count and null-cost count.",
    inputSchema: z.object({}),
  },
  "metric_cost_by_provider": {
    description: "Get LLM API cost breakdown by provider and model. Accepts optional days parameter (7, 30, or 90; default 30).",
    inputSchema: daysSchema,
  },
  "metric_cost_by_agent": {
    description: "Get LLM API cost breakdown by agent/skill. Accepts optional days parameter (7, 30, or 90; default 30).",
    inputSchema: daysSchema,
  },
  "metric_cost_recent_events": {
    description: "Get the most recent LLM API usage events with cost data. Accepts optional limit parameter (1-100; default 20).",
    inputSchema: limitSchema,
  },
  "metric_cost_budget_get": {
    description: "Get the current monthly budget configuration for LLM API costs.",
    inputSchema: z.object({}),
  },
  "metric_cost_timeseries": {
    description: "Get daily LLM API cost time series for charting. Returns { days, groupBy, granularity, points: [{ date, buckets, total }] }. groupBy can be 'provider' (default), 'agent', or 'model'. days defaults to 14, max 366. Use this to build [chart:{...}] embeds.",
    inputSchema: timeseriesSchema,
  },
};

export function registerMetricCostPrimitives(server: McpRuntimeToolServer) {
  const handlers = createMetricCostPrimitiveHandlers();

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
