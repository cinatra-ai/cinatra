import "server-only";

export { insertUsageEvent } from "./store";
export { computeLlmCostUsd, computeApolloCostUsd } from "./pricing";
export { startUsageEventSubscriber } from "./event-subscriber";
export { createMetricsCostModule } from "./integration/module";
export { MetricsCostOverviewScreen } from "./screens";
export { MetricsCostPricingScreen } from "./screens";
export { MetricsTracesScreen } from "./screens";

// --- Dashboard store exports ---
export {
  readCostSummary,
  readCostByProvider,
  readCostByAgent,
  readCostBySkill,
  readCostTimeSeries,
  readRecentEvents,
  readSubscriptionCosts,
  writeSubscriptionCosts,
} from "./store";
export type {
  CostSummaryRow,
  CostByProviderRow,
  CostByAgentRow,
  CostBySkillRow,
  CostTimeSeriesRow,
  SubscriptionCosts,
} from "./store";

// --- Budget alerts ---
export {
  readBudgetConfig,
  writeBudgetConfig,
} from "./store";
export type { BudgetConfig } from "./store";

// --- Legacy cost backfill ---
export {
  readLegacyCosts,
  insertLegacyCostEntry,
  updateLegacyCostEntry,
  deleteLegacyCostEntry,
} from "./store";
export type { LegacyCostEntry } from "./store";

// --- Model pricing ---
export {
  readModelPricing,
  upsertModelPricingRows,
  readModelPricingByModel,
  updateModelPricingRow,
} from "./store";
export type { ModelPricingRow } from "./store";

// --- LiteLLM sync ---
export { runLiteLlmSync, runLiteLlmPricingSyncJob } from "./litellm-sync";
export type { LiteLlmSyncResult } from "./litellm-sync";

// --- Token usage queries ---
export {
  readTokenTimeSeries,
  readTokenByProvider,
} from "./store";
export type {
  TokenTimeSeriesRow,
  TokenByProviderRow,
} from "./store";

// --- OTel traces table symbol ---
export { traces } from "./schema";

// --- Database handle - exposed for the OTLP receiver route in src/app/api/otel/... ---
export { db } from "./db";

// --- OTel span exporter ---
export { PostgresSpanExporter } from "./span-exporter";

// --- Trace store queries ---
export {
  readRecentTraces,
  readTracesByRunId,
} from "./store";
export type { TraceSpanRow } from "./store";
