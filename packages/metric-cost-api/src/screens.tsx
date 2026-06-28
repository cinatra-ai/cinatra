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
import { getPrimarySavedNangoConnections, NANGO_CONNECTOR_DEFINITIONS } from "@/lib/nango-system";
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
import { readTracesByRunId, readRecentTraces, readTraceServices } from "./store";
import { parseTraceFilters } from "./trace-filters";
import { TraceSpanTable } from "./components/trace-span-table";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

const RECENT_TRACES_LIMIT = 200;
const FILTER_FIELD_CLASS =
  "mt-1 block w-40 rounded-control border border-line bg-surface px-3 py-1.5 text-sm text-foreground";

type MetricsTracesScreenProps = {
  runId?: string;
  from?: string;
  to?: string;
  service?: string;
};

// Server-rendered GET form: filters apply via query params (#491) — no client
// JS, native controls submit straight into the URL the screen reads back.
function TraceFilterBar({
  services,
  from,
  to,
  service,
}: {
  services: string[];
  from?: string;
  to?: string;
  service?: string;
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <div>
        <Label htmlFor="tf-from" className="text-xs font-medium text-muted-foreground">From</Label>
        <Input id="tf-from" name="from" type="date" defaultValue={from ?? ""} className={FILTER_FIELD_CLASS} />
      </div>
      <div>
        <Label htmlFor="tf-to" className="text-xs font-medium text-muted-foreground">To</Label>
        <Input id="tf-to" name="to" type="date" defaultValue={to ?? ""} className={FILTER_FIELD_CLASS} />
      </div>
      <div>
        <Label htmlFor="tf-service" className="text-xs font-medium text-muted-foreground">Service</Label>
        <NativeSelect id="tf-service" name="service" defaultValue={service ?? "all"} className={FILTER_FIELD_CLASS}>
          <option value="all">All services</option>
          {services.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" variant="outline" size="sm">Apply</Button>
      <Button asChild variant="ghost" size="sm">
        <Link href="?">Clear</Link>
      </Button>
    </form>
  );
}

export async function MetricsTracesScreen({
  runId,
  from,
  to,
  service,
}: MetricsTracesScreenProps) {
  // Single-run view: the span tree for one run, unfiltered.
  if (runId) {
    const spans = await readTracesByRunId(runId);
    if (spans.length === 0) {
      return (
        <div className="soft-panel rounded-panel p-6">
          <p className="text-sm text-muted-foreground">
            {`No spans recorded for run ${runId}. Tracing may be disabled or the run has not produced spans yet.`}
          </p>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-6">
        <TraceSpanTable spans={spans} mode="tree" />
      </div>
    );
  }

  // Recent view: server-side date-range + service filters. The filter bar always
  // renders (so an empty result is adjustable); the row cap is surfaced, not
  // silent (#491).
  const filters = parseTraceFilters({ from, to, service });
  const hasFilters = Boolean(filters.from || filters.to || filters.service);
  const [services, spans] = await Promise.all([
    readTraceServices(),
    readRecentTraces({ ...filters, limit: RECENT_TRACES_LIMIT }),
  ]);
  const capped = spans.length >= RECENT_TRACES_LIMIT;

  return (
    <div className="flex flex-col gap-4">
      <TraceFilterBar services={services} from={from} to={to} service={service} />
      {spans.length === 0 ? (
        <div className="soft-panel rounded-panel p-6">
          <p className="text-sm text-muted-foreground">
            {hasFilters
              ? "No spans match these filters. Widen the date range or clear the filters."
              : "No spans recorded yet. Trigger an agent run to see traces."}
          </p>
        </div>
      ) : (
        <>
          {capped && (
            <p className="text-xs text-muted-foreground">
              Showing the most recent {RECENT_TRACES_LIMIT} spans (capped) — narrow the date range to see older spans.
            </p>
          )}
          <TraceSpanTable spans={spans} mode="recent" />
        </>
      )}
    </div>
  );
}
