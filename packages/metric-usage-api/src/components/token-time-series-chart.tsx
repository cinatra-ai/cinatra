"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { AreaChart, Area, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type TokenTimeSeriesChartProps = {
  data: { day: string; totalInput: number; totalOutput: number }[];
  days: number;
};

const RANGES = [7, 30, 90] as const;

export function TokenTimeSeriesChart({ data, days }: TokenTimeSeriesChartProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleRangeChange(newDays: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("days", String(newDays));
    router.push(`?${params.toString()}`);
  }

  const chartData = data.map((row) => ({
    day: row.day ? row.day.slice(0, 10) : "",
    input: row.totalInput,
    output: row.totalOutput,
  }));

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="px-5 py-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Daily Token Usage</h3>
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
              <linearGradient id="inputFillGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: "var(--chart-1)" }} stopOpacity={0.4} />
                <stop offset="100%" style={{ stopColor: "var(--chart-1)" }} stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="outputFillGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" style={{ stopColor: "var(--chart-2)" }} stopOpacity={0.4} />
                <stop offset="100%" style={{ stopColor: "var(--chart-2)" }} stopOpacity={0.05} />
              </linearGradient>
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
              tickFormatter={(v: number) => v.toLocaleString()}
            />
            <Tooltip
              formatter={(value, name) => [
                Number(value).toLocaleString(),
                name === "input" ? "Input Tokens" : "Output Tokens",
              ]}
              labelFormatter={(label) => String(label)}
            />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(value) => (value === "input" ? "Input Tokens" : "Output Tokens")}
            />
            <Area
              type="monotone"
              dataKey="input"
              name="input"
              stroke="var(--chart-1)"
              strokeWidth={2}
              fill="url(#inputFillGradient)"
              fillOpacity={1}
              activeDot={{ r: 4 }}
            />
            <Area
              type="monotone"
              dataKey="output"
              name="output"
              stroke="var(--chart-2)"
              strokeWidth={2}
              fill="url(#outputFillGradient)"
              fillOpacity={1}
              activeDot={{ r: 4 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      </CardContent>
    </Card>
  );
}
