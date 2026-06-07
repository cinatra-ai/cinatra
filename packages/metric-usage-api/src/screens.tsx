import "server-only";
import { readTokenTimeSeries, readTokenByProvider } from "@cinatra-ai/metric-cost-api";
import { TokenTimeSeriesChart } from "./components/token-time-series-chart";
import { TokenByProviderTable } from "./components/token-by-provider-table";

type MetricUsageOverviewScreenProps = {
  days?: number;
};

export async function MetricUsageOverviewScreen({
  days = 30,
}: MetricUsageOverviewScreenProps) {
  const [timeSeries, byProvider] = await Promise.all([
    readTokenTimeSeries({ days }),
    readTokenByProvider({ days }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <TokenTimeSeriesChart data={timeSeries} days={days} />
      <TokenByProviderTable data={byProvider} />
    </div>
  );
}
