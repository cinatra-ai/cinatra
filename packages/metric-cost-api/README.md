# @cinatra-ai/metric-cost-api

Computes pricing for captured LLM and connector usage events, persists cost and
token data to PostgreSQL, and serves the cost-analytics dashboard. It subscribes
to the usage-event stream from `@cinatra-ai/metric-usage-api`, prices each event,
and exposes summary, breakdown, time-series, budget, and OpenTelemetry-trace
queries used by the admin analytics screens and MCP primitives.

## Public API

- `createMetricsCostModule` — host module: registers capabilities, starts the subscriber.
- `startUsageEventSubscriber` — subscribes to usage events and persists priced rows.
- `computeLlmCostUsd` / `computeApolloCostUsd` — derive USD cost from usage.
- `insertUsageEvent` — write a priced usage event.
- `readCostSummary`, `readCostByProvider`, `readCostByAgent`, `readCostBySkill` — cost rollups.
- `readCostTimeSeries`, `readRecentEvents` — cost over time and recent activity.
- `readTokenTimeSeries`, `readTokenByProvider` — token-usage queries.
- `readSubscriptionCosts` / `writeSubscriptionCosts` — fixed subscription costs.
- `readBudgetConfig` / `writeBudgetConfig` — budget alert configuration.
- `readLegacyCosts`, `insertLegacyCostEntry`, `updateLegacyCostEntry`, `deleteLegacyCostEntry` — one-time fixed-cost entries.
- `readModelPricing`, `upsertModelPricingRows`, `readModelPricingByModel`, `updateModelPricingRow` — model price table access.
- `runLiteLlmSync`, `runLiteLlmPricingSyncJob` — sync model pricing from LiteLLM.
- `readRecentTraces`, `readTracesByRunId` — OpenTelemetry span queries.
- `PostgresSpanExporter`, `traces`, `db` — OTel span exporter, table symbol, and database handle.
- `MetricsCostOverviewScreen`, `MetricsCostPricingScreen`, `MetricsTracesScreen` — analytics screens.
- Types: `CostSummaryRow`, `CostByProviderRow`, `CostByAgentRow`, `CostBySkillRow`, `CostTimeSeriesRow`, `SubscriptionCosts`, `BudgetConfig`, `LegacyCostEntry`, `ModelPricingRow`, `LiteLlmSyncResult`, `TokenTimeSeriesRow`, `TokenByProviderRow`, `TraceSpanRow`.

## Usage

```ts
import { computeLlmCostUsd, readCostSummary } from "@cinatra-ai/metric-cost-api";

const costUsd = await computeLlmCostUsd({
  model: "gpt-4o",
  inputTokens: 1200,
  outputTokens: 350,
});

const summary = await readCostSummary();
```

## Docs

See https://docs.cinatra.ai
