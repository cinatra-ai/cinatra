"use client";

import {
  BarChart, Bar,
  LineChart, Line,
  AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import type { ChartSpec } from "./chart-schema";

// ---------------------------------------------------------------------------
// Color palette — uses CSS custom properties where available, then falls back
// to hardcoded hex values that look reasonable in both light and dark themes.
// ---------------------------------------------------------------------------

const PALETTE = [
  "var(--chart-1, #6366f1)",
  "var(--chart-2, #22c55e)",
  "var(--chart-3, #f59e0b)",
  "var(--chart-4, #ef4444)",
  "var(--chart-5, #8b5cf6)",
  "#60a5fa",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#a78bfa",
  "#f472b6",
  "#fb923c",
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatValue(value: number, format?: ChartSpec["yFormat"]): string {
  if (format === "currency_usd") {
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });
  }
  if (format === "percent") {
    return `${(value * 100).toFixed(1)}%`;
  }
  return value.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// ChartEmbed — renders a validated ChartSpec as a Recharts chart.
//
// Security: string fields from the spec are rendered as text nodes by Recharts
// (never injected as innerHTML), so XSS from LLM-controlled title/label values
// is not possible. validateChart() MUST be called before passing spec here.
// ---------------------------------------------------------------------------

export function ChartEmbed({ spec }: { spec: ChartSpec }) {
  const data = spec.x.map((label, i) => {
    const row: Record<string, number | string> = { x: label };
    spec.series.forEach((s) => { row[s.name] = s.data[i] ?? 0; });
    return row;
  });

  const yFormatter = (v: number) => formatValue(v, spec.yFormat);
  const showLegend = spec.legend !== false && spec.series.length > 1;

  const commonAxes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border, #e2e8f0)" />
      <XAxis
        dataKey="x"
        stroke="var(--muted-foreground, #64748b)"
        fontSize={11}
        tick={{ fill: "var(--muted-foreground, #64748b)" }}
      />
      <YAxis
        stroke="var(--muted-foreground, #64748b)"
        fontSize={11}
        tickFormatter={yFormatter}
        tick={{ fill: "var(--muted-foreground, #64748b)" }}
      />
      <Tooltip
        formatter={(v: unknown) => formatValue(v as number, spec.yFormat)}
        contentStyle={{
          background: "var(--surface, #ffffff)",
          border: "1px solid var(--border, #e2e8f0)",
          borderRadius: 6,
          fontSize: 12,
        }}
      />
      {showLegend && <Legend wrapperStyle={{ fontSize: 12 }} />}
    </>
  );

  return (
    <div className="my-3 rounded-lg border border-line bg-surface p-4">
      <div className="mb-1 text-sm font-semibold text-foreground">{spec.title}</div>
      {spec.subtitle && (
        <div className="mb-3 text-xs text-muted-foreground">{spec.subtitle}</div>
      )}
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {spec.type === "bar" ? (
            <BarChart data={data}>
              {commonAxes}
              {spec.series.map((s, i) => (
                <Bar
                  key={s.name}
                  dataKey={s.name}
                  fill={PALETTE[i % PALETTE.length]}
                  stackId={spec.stacked ? "stack" : undefined}
                />
              ))}
            </BarChart>
          ) : spec.type === "line" ? (
            <LineChart data={data}>
              {commonAxes}
              {spec.series.map((s, i) => (
                <Line
                  key={s.name}
                  dataKey={s.name}
                  type="monotone"
                  stroke={PALETTE[i % PALETTE.length]}
                  dot={false}
                  strokeWidth={2}
                />
              ))}
            </LineChart>
          ) : (
            <AreaChart data={data}>
              {commonAxes}
              {spec.series.map((s, i) => (
                <Area
                  key={s.name}
                  dataKey={s.name}
                  type="monotone"
                  stroke={PALETTE[i % PALETTE.length]}
                  fill={PALETTE[i % PALETTE.length]}
                  fillOpacity={0.3}
                  stackId={spec.stacked ? "stack" : undefined}
                />
              ))}
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChartError — rendered when validateChart() returns null, so the chat never
// crashes on a malformed [chart:...] embed.
// ---------------------------------------------------------------------------

export function ChartError({ reason }: { reason: string }) {
  return (
    <div className="my-3 rounded-lg border border-line bg-surface-muted p-3 text-xs text-muted-foreground">
      Chart could not be rendered: {reason}
    </div>
  );
}
