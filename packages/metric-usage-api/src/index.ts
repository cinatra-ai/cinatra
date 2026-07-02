// The usage-event types + bus now live in @cinatra-ai/metric-contracts (the
// one-directional shared seam that broke the metric-usage-api <-> metric-cost-api
// cycle). They are re-exported here UNCHANGED so this package's public API stays
// byte-compatible for every existing consumer (the LLM/connector call paths that
// call emitUsageEvent, plus the dashboard/MCP surfaces).
export type { UsageEvent, LlmUsageEvent, ApolloUsageEvent } from "@cinatra-ai/metric-contracts";
export { emitUsageEvent, onUsageEvent } from "@cinatra-ai/metric-contracts";

export { createMetricUsageMcpModule } from "./mcp/module";
