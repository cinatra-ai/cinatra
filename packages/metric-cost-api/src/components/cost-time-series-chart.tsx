"use client";

import type { ReactElement } from "react";
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
import {
  buildDailyCostChartRows,
  describeBucketCost,
  shouldRingBucket,
  unknownCostNote,
} from "./cost-by-provider-table";

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

// ---------------------------------------------------------------------------
// How this chart draws a cost it does not know (cinatra#2669).
//
// The series is `SUM(cost_usd)`, which SKIPS unpriced rows. Until now the query
// coalesced that sum to 0, so three different days were drawn at the same
// height: a day with no activity, a day that genuinely cost nothing, and a day
// whose ONLY activity was an image call or a knowledge-graph episode — real
// spend, unknown amount. The line said "$0.00" for all three.
//
// The store now answers `cost: null` for a bucket with nothing priced, plus the
// count of rows the subtotal skipped, and the chart states both:
//
//   - UNPRICED-ONLY buckets are a GAP in the area, never a point at zero. A gap
//     is the only mark that asserts no amount, and it is the whole reason the
//     value reaches recharts as `null` instead of being clamped.
//   - MIXED buckets are drawn at their known subtotal — a real number — and
//     RINGED, because the drawn height is the part that could be priced and not
//     the day's spend.
//   - The tooltip names every bucket's unpriced-row count, for both cases, and
//     keeps measured zero ("$0.0000") apart from an empty day ("no events").
//   - A caption under the chart says how much of the range is affected, so the
//     gaps and rings are legible without hovering.
//
// EMPTY buckets keep drawing at 0: nothing happened, and zero dollars is the
// truthful height for it.
// ---------------------------------------------------------------------------

type ChartRow = Record<string, string | number | null>;

/** The dot recharts hands a custom renderer, narrowed to what is read here. */
type DotProps = {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: ChartRow;
};

export function CostTimeSeriesChart({ data, days }: CostTimeSeriesChartProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleRangeChange(newDays: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("days", String(newDays));
    router.push(`?${params.toString()}`);
  }

  // Two views of the same rows, built by one pure, directly-tested pivot:
  // `chartRows` is what recharts plots (a number, or `null` where there is no
  // amount to draw), and `bucketsByDay` keeps the STORE rows verbatim for the
  // tooltip, because plotting flattens a distinction the tooltip must keep —
  // an empty day and a genuinely $0 day are both drawn at 0, and only the
  // original `cost === null` tells them apart.
  const { providers, chartRows, bucketsByDay, unknownRowTotal, unknownDayCount } =
    buildDailyCostChartRows(data);

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
            <AreaChart data={chartRows}>
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
              content={({ active, label }) => (
                <UnknownAwareTooltip
                  active={active}
                  label={label as string | number | undefined}
                  providers={providers}
                  buckets={bucketsByDay}
                />
              )}
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
                // A null bucket is a HOLE, not a zero: leave the area broken.
                connectNulls={false}
                dot={((props: DotProps) => (
                  <UnknownCostDot
                    {...props}
                    color={CHART_COLORS[i % CHART_COLORS.length]}
                    provider={provider}
                    buckets={bucketsByDay}
                  />
                )) as never}
                activeDot={{ r: 4 }}
              />
            ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
        {unknownRowTotal > 0 && (
          <p className="mt-3 text-xs text-muted-foreground" data-testid="daily-cost-unknown-note">
            {unknownCostNote(unknownRowTotal, unknownDayCount)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The mark for a bucket whose drawn height is only PART of its spend.
 *
 * A mixed bucket has a real subtotal, so it must still be plotted — but plotting
 * it plain would present a partial number as the day's cost. The ring says the
 * point is qualified; the tooltip says by how much. Buckets with nothing
 * unpriced render recharts' ordinary (absent) dot.
 */
function UnknownCostDot(
  props: DotProps & {
    color: string;
    provider: string;
    buckets: Map<string, Map<string, CostTimeSeriesRow>>;
  },
): ReactElement {
  const { cx, cy, payload, color, provider, buckets, index } = props;
  const key = `dot-${provider}-${index ?? 0}`;
  // The STORE row, not the plotted one: the plotted value cannot say whether a
  // 0 is measured or fabricated, and the chart row deliberately carries no
  // sidecar keys (a `"<provider>__unknown"` companion would collide with a
  // provider genuinely called that).
  const bucket = buckets.get(String(payload?.day ?? ""))?.get(provider);
  if (
    !shouldRingBucket(bucket) ||
    !Number.isFinite(cx as number) ||
    !Number.isFinite(cy as number)
  ) {
    return <g key={key} />;
  }
  return (
    <g key={key} data-unknown-cost-marker={String(bucket!.unknownCostCount)}>
      <circle cx={cx} cy={cy} r={5} fill="none" stroke={color} strokeWidth={1.5} />
      <circle cx={cx} cy={cy} r={2} fill={color} />
    </g>
  );
}

/**
 * The tooltip reads the STORE rows, not recharts' payload.
 *
 * recharts drops null-valued series from the payload it hands a tooltip, which
 * is exactly the bucket that most needs explaining: the day whose whole cost is
 * unknown would silently vanish from the hover card and leave the gap
 * unexplained. Reading the store rows directly keeps every provider present for
 * every day, priced or not, and keeps `cost: null` (no amount) apart from
 * `cost: 0` (an amount that happens to be zero).
 */
function UnknownAwareTooltip({
  active,
  label,
  providers,
  buckets,
}: {
  active?: boolean;
  label?: string | number;
  providers: string[];
  buckets: Map<string, Map<string, CostTimeSeriesRow>>;
}): ReactElement | null {
  if (!active || label === undefined || label === null) return null;
  const day = buckets.get(String(label));
  if (!day) return null;
  return (
    <div className="rounded-panel border border-line bg-surface px-3 py-2 text-xs shadow-sm">
      <p className="font-medium text-foreground">{String(label)}</p>
      <ul className="mt-1 flex flex-col gap-0.5">
        {providers.map((provider) => {
          const row = day.get(provider);
          return (
            <li key={provider} className="text-muted-foreground">
              <span className="text-foreground">{provider}</span>
              {": "}
              {row
                ? describeBucketCost(row.cost, row.unknownCostCount)
                : describeBucketCost(null, 0)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
