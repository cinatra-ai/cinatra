import { z } from "zod";
import type { PrimitiveInvocationRequest } from "@cinatra-ai/mcp-client";

export const daysSchema = z.object({
  days: z.number().int().positive().optional().default(30),
});

export function createMetricUsagePrimitiveHandlers() {
  return {
    "metric_usage_events": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { days } = daysSchema.parse(request.input);
      const { readTokenTimeSeries } = await import("@cinatra-ai/metric-cost-api");
      return readTokenTimeSeries({ days });
    },

    "metric_usage_summary": async (request: PrimitiveInvocationRequest<unknown>) => {
      const { days } = daysSchema.parse(request.input);
      const { readTokenByProvider } = await import("@cinatra-ai/metric-cost-api");
      return readTokenByProvider({ days });
    },
  } as const;
}
