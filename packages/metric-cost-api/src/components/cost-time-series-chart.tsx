"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { CostTimeSeriesRow } from "../store";

type CostTimeSeriesChartProps = {
  data: CostTimeSeriesRow[];
  days: number;
};

const RANGES = [7, 30, 90] as const;

// CSS variable tokens cycling through chart-1 … chart-5
// Use var() directly — --chart-N values are oklch(), not hsl()
const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function CostTimeSeriesChart({ data, days }: CostTimeSeriesChartProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleRangeChange(newDays: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("days", String(newDays));
    router.push(`?${params.toString()}`);
  }

  // Collect distinct providers in stable order
  const providers = [...new Set(data.map((r) => r.provider))].sort();

  // Pivot long rows → wide format: { day, [provider]: cost, … }
  const dayMap = new Map<string, Record<string, string | number>>();
  for (const row of data) {
    if (!dayMap.has(row.day)) dayMap.set(row.day, { day: row.day });
    dayMap.get(row.day)![row.provider] = row.cost;
  }
  const chartData = [...dayMap.values()];

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="px-5 py-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Daily Cost</h3>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <Button
                key={r}
                type="button"
                variant="ghost"
                onClick={() => handleRangeChange(r)}
                className={`h-auto rounded-chip px-3 py-1 text-xs font-medium transition ${
                  days === r
                    ? "bg-foreground text-background"
                    : "bg-surface-muted text-muted-foreground hover:bg-surface-strong"
                }`}
              >
                {r}d
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData}>
            <defs>
              {providers.map((provider, i) => (
                <linearGradient
                  key={provider}
                  id={`fill-${provider}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    style={{ stopColor: CHART_COLORS[i % CHART_COLORS.length] }}
                    stopOpacity={0.4}
                  />
                  <stop
                    offset="100%"
                    style={{ stopColor: CHART_COLORS[i % CHART_COLORS.length] }}
                    stopOpacity={0.05}
                  />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" className="stroke-line" />
            <XAxis
              dataKey="day"
              tick={{ fontSize: 11 }}
              className="text-muted-foreground"
              interval={days <= 7 ? 0 : days <= 30 ? 4 : 14}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              className="text-muted-foreground"
              tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            />
            <Tooltip
              formatter={(value, name) => [
                `$${Number(value).toFixed(4)}`,
                String(name),
              ]}
              labelFormatter={(label) => String(label)}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(value) => String(value)}
            />
            {providers.map((provider, i) => (
              <Area
                key={provider}
                type="monotone"
                dataKey={provider}
                name={provider}
                stroke={CHART_COLORS[i % CHART_COLORS.length]}
                strokeWidth={2}
                fill={`url(#fill-${provider})`}
                fillOpacity={1}
                activeDot={{ r: 4 }}
              />
            ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
