import "server-only";
import {
  readCostSummary,
  readCostByProvider,
  readCostByAgent,
  readCostBySkill,
  readCostTimeSeries,
  readRecentEvents,
  readBudgetConfig,
  readLegacyCosts,
  readModelPricing,
} from "./store";
import { getPrimarySavedNangoConnections, NANGO_CONNECTOR_DEFINITIONS } from "@cinatra-ai/nango-connector";
import { CostSummaryCards } from "./components/cost-summary-cards";
import { CostTimeSeriesChart } from "./components/cost-time-series-chart";
import { CostBreakdownTabs } from "./components/cost-breakdown-tabs";
import { RecentEventsLog } from "./components/recent-events-log";
import { BudgetAlert } from "./components/budget-alert";
import { LegacyCostList } from "./components/legacy-cost-list";
import { ModelPricingTable } from "./components/model-pricing-table";

type MetricsCostOverviewScreenProps = {
  days?: number;
  provider?: string;
};

export async function MetricsCostOverviewScreen({
  days = 30,
  provider,
}: MetricsCostOverviewScreenProps) {
  const [summary, byProvider, byAgent, bySkill, timeSeries, recentEvents, budgetConfig, legacyCosts] =
    await Promise.all([
      readCostSummary(),
      readCostByProvider({ days }),
      readCostByAgent({ days }),
      readCostBySkill({ days }),
      readCostTimeSeries({ days }),
      readRecentEvents({ limit: 50, provider }),
      readBudgetConfig(),
      readLegacyCosts(),
    ]);

  // Extract unique providers for the filter dropdown
  const providers = [...new Set(recentEvents.map((e) => String(e.provider)).filter(Boolean))].sort();

  // Build provider dropdown options from connected Nango APIs
  const nangoConnections = getPrimarySavedNangoConnections();

  // Map from Nango connector key to the provider name used in usage_events / legacy_costs
  const CONNECTOR_KEY_TO_PROVIDER: Record<string, string> = {
    openai: "openai",
    claude: "anthropic",
    gemini: "gemini",
    apollo: "apollo",
  };

  const connectedProviders = Object.entries(nangoConnections)
    .filter(([, conn]) => conn !== null)
    .map(([key]) => {
      const providerValue = CONNECTOR_KEY_TO_PROVIDER[key] ?? key;
      const def = NANGO_CONNECTOR_DEFINITIONS[key as keyof typeof NANGO_CONNECTOR_DEFINITIONS];
      return { value: providerValue, label: def?.title ?? key };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="flex flex-col gap-6">
      <CostSummaryCards summary={summary} legacyCosts={legacyCosts} />
      <BudgetAlert summary={summary} budgetConfig={budgetConfig} legacyCosts={legacyCosts} />
      <CostTimeSeriesChart data={timeSeries} days={days} />
      <CostBreakdownTabs
        byProvider={byProvider}
        byAgent={byAgent}
        bySkill={bySkill}
        legacyCosts={legacyCosts}
      />
      <RecentEventsLog
        events={recentEvents}
        currentProvider={provider}
        providers={providers}
      />
      <LegacyCostList legacyCosts={legacyCosts} connectedProviders={connectedProviders} />
    </div>
  );
}

export async function MetricsCostPricingScreen() {
  const rows = await readModelPricing();
  return (
    <div className="flex flex-col gap-6">
      <ModelPricingTable rows={rows} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin traces screen.
// Two modes:
//   - runId=<id>: show the span tree for a single agent run.
//   - (no runId): show the most recent 200 spans across all runs.
// ---------------------------------------------------------------------------
import { readTracesByRunId, readRecentTraces } from "./store";
import { TraceSpanTable } from "./components/trace-span-table";

type MetricsTracesScreenProps = {
  runId?: string;
};

export async function MetricsTracesScreen({
  runId,
}: MetricsTracesScreenProps) {
  const spans = runId
    ? await readTracesByRunId(runId)
    : await readRecentTraces({ limit: 200 });

  if (spans.length === 0) {
    return (
      <div className="soft-panel rounded-panel p-6">
        <p className="text-sm text-muted-foreground">
          {runId
            ? `No spans recorded for run ${runId}. Tracing may be disabled or the run has not produced spans yet.`
            : "No spans recorded yet. Trigger an agent run to see traces."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <TraceSpanTable spans={spans} mode={runId ? "tree" : "recent"} />
    </div>
  );
}
