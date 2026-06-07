import { z } from "zod";
import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";

export const daysSchema = z.object({
  days: z.number().int().positive().optional().default(30),
});

export const limitSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export const timeseriesSchema = z.object({
  days: z.number().int().positive().max(366).optional().default(14),
  groupBy: z.enum(["provider", "agent", "model"]).optional().default("provider"),
});

export function createMetricCostPrimitiveHandlers() {
  return {
    "metric_cost_summary": async (_request: PrimitiveInvocationRequest<unknown>) => {
      const { readCostSummary } = await import("../store");
      return readCostSummary();
    },

    "metric_cost_by_provider": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { days } = daysSchema.parse(request.input);
      const { readCostByProvider } = await import("../store");
      return readCostByProvider({ days });
    },

    "metric_cost_by_agent": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { days } = daysSchema.parse(request.input);
      const { readCostByAgent } = await import("../store");
      return readCostByAgent({ days });
    },

    "metric_cost_recent_events": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { limit } = limitSchema.parse(request.input);
      const { readRecentEvents } = await import("../store");
      return readRecentEvents({ limit });
    },

    "metric_cost_budget_get": async (_request: PrimitiveInvocationRequest<unknown>) => {
      const { readBudgetConfig } = await import("../store");
      return readBudgetConfig();
    },

    "metric_cost_timeseries": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { days, groupBy } = timeseriesSchema.parse(request.input);
      const { readCostTimeseriesForChart } = await import("../store");
      return readCostTimeseriesForChart({ days, groupBy });
    },
  } as const;
}
