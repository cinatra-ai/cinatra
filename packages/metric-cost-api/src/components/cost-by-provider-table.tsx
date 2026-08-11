import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import type { CostByProviderRow, LegacyCostEntry } from "../store";

// ---------------------------------------------------------------------------
// How a breakdown row STATES what it knows (cinatra#2582).
//
// Pure formatters, exported from THIS component module on purpose. They cannot
// live in `../store` (it is `server-only`, and this component is reachable from
// the pages router) and they must not become a new leaf module: every locked
// dev-perf route already reaches this file, and a new one would grow all five
// reachable graphs by one — which the route-graph ratchet correctly refuses for
// a pair of string helpers. The tests import them from here.
//
// Each exists to stop a quiet overstatement:
//
//   - an UNPRICED row (no rate card, or a producer that never reports its
//     usage) used to render "$0.0000", which reads as "this was free";
//   - a knowledge-graph row counts EPISODES, and one episode fans out to an
//     unknown number of provider requests inside the indexer's own container,
//     so a bare number under a "Calls" heading understates the request volume
//     by an unknown multiple;
//   - a group MIXING priced and unpriced rows sums to a number that looks
//     complete, because `SUM(cost_usd)` skips NULLs (cinatra#2641). All three
//     breakdown tabs use `formatCostCell`, which states the remainder.
//
// All three tabs import these from here for the same reason: one formatter, one
// wording, no per-tab drift about what "unknown" looks like — and cinatra#2669
// widens that circle to the Daily Cost tooltip and the monthly budget alert,
// which report partial totals of their own.
// ---------------------------------------------------------------------------

/** Dollars, or the word "unknown" — never a number the ledger cannot back. */
export function formatUsd(v: number | null): string {
  if (v === null || v === undefined) return "unknown";
  return `$${v.toFixed(4)}`;
}

/**
 * A breakdown row's cost cell: the subtotal AND what it leaves out (cinatra#2641).
 *
 * `SUM(cost_usd)` skips NULLs, so a group holding priced and unpriced rows
 * answers with a number that LOOKS complete. {@link formatUsd} alone can only
 * tell the truth about a group where every row is unpriced. Mixed groups became
 * ordinary when image calls started booking counted-but-unpriced rows that share
 * a provider, an agent or a skill with priced work, so the cell states the
 * remainder instead of hiding it:
 *
 *   0 unknown        -> "$1.2345"          (a complete subtotal)
 *   some unknown     -> "$1.2345 + 2 unknown-cost rows"
 *   nothing priced   -> "unknown"          (there is no subtotal to show)
 */
export function formatCostCell(
  total: number | null,
  unknownCostCount: number,
): string {
  if (!unknownCostCount || unknownCostCount < 0) return formatUsd(total);
  if (total === null || total === undefined) return "unknown";
  return `${formatUsd(total)} + ${unknownRowsPhrase(unknownCostCount)}`;
}

/**
 * The one noun phrase for "rows this total could not price" (cinatra#2669).
 *
 * Every surface that reports a partial total — the three breakdown cells, the
 * Daily Cost tooltip, the monthly budget alert — says it with THIS phrase, so an
 * operator meets the same words wherever the ledger is incomplete and no surface
 * can quietly invent a softer one.
 */
export function unknownRowsPhrase(unknownCostCount: number): string {
  return `${unknownCostCount} unknown-cost ${unknownCostCount === 1 ? "row" : "rows"}`;
}

/**
 * A TIME-SERIES bucket's cost, for a surface with no Calls column to lean on
 * (cinatra#2669).
 *
 * {@link formatCostCell} sits in a table where a neighbouring column already
 * states the row count, so its all-unpriced answer is the bare word "unknown".
 * A chart tooltip has no such neighbour: "unknown" alone would leave an operator
 * unable to tell one unpriced call from fifty. This variant therefore always
 * names the count, and — because a dense date spine emits buckets for days that
 * hold nothing at all — distinguishes the empty bucket from the unpriced one:
 *
 *   `(0, 0)`      -> "$0.0000"                     measured zero
 *   `(1.2345, 0)` -> "$1.2345"                     a complete subtotal
 *   `(1.2345, 2)` -> "$1.2345 + 2 unknown-cost rows"  partial
 *   `(null, 3)`   -> "unknown (3 unknown-cost rows)"  nothing priced
 *   `(null, 0)`   -> "no events"                   nothing happened
 */
export function describeBucketCost(
  knownCost: number | null,
  unknownCostCount: number,
): string {
  const unknown = unknownCostCount > 0 ? unknownCostCount : 0;
  if (knownCost === null || knownCost === undefined) {
    return unknown === 0 ? "no events" : `unknown (${unknownRowsPhrase(unknown)})`;
  }
  if (unknown === 0) return formatUsd(knownCost);
  return `${formatUsd(knownCost)} + ${unknownRowsPhrase(unknown)}`;
}

/** The bucket shape the Daily Cost chart consumes, mirrored from the store. */
export type DailyCostBucket = {
  day: string;
  provider: string;
  cost: number | null;
  unknownCostCount: number;
};

/**
 * Pivot the store's long (day, provider) rows into what the Daily Cost chart
 * plots — a PURE function, on purpose (cinatra#2669).
 *
 * The distinction this issue exists to preserve lives entirely in this pivot: a
 * bucket the chart must draw as a GAP (`null`), a bucket it must draw at zero
 * because nothing happened, and a bucket at a real measured zero all pass
 * through here. Inside a `ResponsiveContainer` that measures 0x0 headless, none
 * of it is assertable, so the decision is lifted out of the component and
 * tested directly; the component keeps only the drawing.
 *
 * `bucketsByDay` hands the ORIGINAL rows back: plotting is lossy (an empty
 * bucket and a genuine $0 are both drawn at 0), so the tooltip AND the ring
 * marker read the store rows from here rather than from the plotted row. That
 * also keeps the chart row a pure `day + one key per provider` namespace —
 * carrying a `"<provider>__unknown"` sidecar key inside it would collide with a
 * provider genuinely called `foo__unknown`, which is a database value.
 */
export function buildDailyCostChartRows(data: readonly DailyCostBucket[]): {
  providers: string[];
  chartRows: Array<Record<string, string | number | null>>;
  bucketsByDay: Map<string, Map<string, DailyCostBucket>>;
  unknownRowTotal: number;
  unknownDayCount: number;
} {
  const providers = [...new Set(data.map((r) => r.provider))].sort();
  // Maps, not `{}`: a provider (and, on other groupings, an agent or a model)
  // is a database value, and assigning `__proto__` on an object literal mutates
  // the prototype instead of creating a key. `Object.fromEntries` materialises
  // the plain rows recharts wants only after the accumulation is done.
  const perDay = new Map<string, Map<string, number | null>>();
  const bucketsByDay = new Map<string, Map<string, DailyCostBucket>>();
  for (const row of data) {
    if (!perDay.has(row.day)) perDay.set(row.day, new Map());
    if (!bucketsByDay.has(row.day)) bucketsByDay.set(row.day, new Map());
    // An EMPTY bucket (no rows at all) draws at 0 — nothing happened, so zero
    // is the true height. An UNPRICED-ONLY bucket stays null and breaks the area.
    const isEmpty = row.cost === null && row.unknownCostCount === 0;
    perDay.get(row.day)!.set(row.provider, isEmpty ? 0 : row.cost);
    bucketsByDay.get(row.day)!.set(row.provider, row);
  }
  const chartRows = [...perDay.entries()].map(([day, cells]) => ({
    day,
    ...Object.fromEntries(cells),
  }));
  // Counted over the SAME rows the chart draws, so the caption can never
  // describe another window.
  const unknownRowTotal = data.reduce((sum, r) => sum + (r.unknownCostCount || 0), 0);
  const unknownDayCount = new Set(
    data.filter((r) => r.unknownCostCount > 0).map((r) => r.day),
  ).size;
  return { providers, chartRows, bucketsByDay, unknownRowTotal, unknownDayCount };
}

/**
 * Whether a plotted point must be RINGED: it is drawn at a real height, and
 * that height is only PART of the bucket's spend (cinatra#2669).
 *
 * BOTH halves are required. A ring on the wrong bucket is worse than no ring:
 * it would qualify a subtotal that is in fact complete, or — with only the count
 * checked — mark an UNPRICED-ONLY bucket, which has no point to ring because it
 * is a gap. Reading the store row (rather than the plotted one) is what lets the
 * rule test the value it claims to be about.
 */
export function shouldRingBucket(bucket: DailyCostBucket | undefined): boolean {
  if (!bucket) return false;
  const { cost, unknownCostCount } = bucket;
  if (typeof cost !== "number" || !Number.isFinite(cost)) return false;
  return typeof unknownCostCount === "number" && unknownCostCount > 0;
}

/**
 * The caption that makes the chart's gaps and rings legible without a hover.
 *
 * A chart that draws honestly but never SAYS what it is drawing still leaves an
 * operator to guess why a line stops.
 */
export function unknownCostNote(unknownRowTotal: number, unknownDayCount: number): string {
  const dayWord = unknownDayCount === 1 ? "day" : "days";
  return (
    `Unknown cost: ${unknownRowsPhrase(unknownRowTotal)} on ` +
    `${unknownDayCount} ${dayWord} in this range. The lines plot KNOWN cost only — ` +
    `a day with nothing priced is a gap, not a $0, and a ringed point is a partial amount.`
  );
}

/** What the row's count MEANS, given which producer wrote it. */
export function describeUnit(source: string, count: number): string {
  if (source === "graphiti") return `${count} episodes`;
  return String(count);
}

/** The model column for rows that have no model to name. */
export function describeModel(source: string, model: string | null): string {
  if (model) return model;
  if (source === "graphiti") return "knowledge-graph episodes (fan-out not reported)";
  return "(unknown)";
}

type CostByProviderTableProps = {
  data: CostByProviderRow[];
  legacyCosts: LegacyCostEntry[];
};

function frequencySuffix(frequency: string): string {
  if (frequency === "monthly") return "/mo";
  if (frequency === "yearly") return "/yr";
  return "";
}

export function CostByProviderTable({ data, legacyCosts }: CostByProviderTableProps) {
  const legacyRows = legacyCosts.map((entry) => {
    const prefix = entry.costType === "subscription" ? "Subscription" : "Legacy";
    return {
      provider: entry.provider,
      label: entry.startDate && entry.endDate
        ? `${prefix} (${entry.startDate} \u2013 ${entry.endDate}): ${entry.description}`
        : `${prefix}: ${entry.description}`,
      cost: parseFloat(entry.costUsd),
      frequency: entry.frequency,
    };
  });

  return (
    <div className="overflow-auto">
      <PaginatedTable className="w-full text-sm">
        <TableHeader>
          <TableRow className="border-b border-line text-left text-muted-foreground">
            <TableHead className="pb-2 pr-4 font-medium">Provider</TableHead>
            <TableHead className="pb-2 pr-4 font-medium">Model</TableHead>
            <TableHead className="pb-2 pr-4 font-medium text-right">Cost</TableHead>
            <TableHead className="pb-2 pr-4 font-medium text-right">Calls</TableHead>
            <TableHead className="pb-2 pr-4 font-medium text-right">Input Tokens</TableHead>
            <TableHead className="pb-2 font-medium text-right">Output Tokens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {legacyRows.map((row, i) => (
            <TableRow key={`legacy-${i}`} className="border-b border-line/50 text-foreground">
              <TableCell className="py-2 pr-4">{row.provider}</TableCell>
              <TableCell className="py-2 pr-4 italic text-muted-foreground">{row.label}</TableCell>
              <TableCell className="py-2 pr-4 text-right">${row.cost.toFixed(2)}{frequencySuffix(row.frequency)}</TableCell>
              <TableCell className="py-2 pr-4 text-right text-muted-foreground">-</TableCell>
              <TableCell className="py-2 pr-4 text-right text-muted-foreground">-</TableCell>
              <TableCell className="py-2 text-right text-muted-foreground">-</TableCell>
            </TableRow>
          ))}
          {data.map((row, i) => (
            <TableRow key={i} className="border-b border-line/50 text-foreground">
              <TableCell className="py-2 pr-4">{row.provider}</TableCell>
              <TableCell className="py-2 pr-4">{describeModel(row.source, row.model)}</TableCell>
              <TableCell className="py-2 pr-4 text-right">{formatCostCell(row.totalCost, row.unknownCostCount)}</TableCell>
              <TableCell className="py-2 pr-4 text-right">{describeUnit(row.source, row.callCount)}</TableCell>
              <TableCell className="py-2 pr-4 text-right">{row.totalInput?.toLocaleString()}</TableCell>
              <TableCell className="py-2 text-right">{row.totalOutput?.toLocaleString()}</TableCell>
            </TableRow>
          ))}
          {data.length === 0 && legacyRows.length === 0 && (
            <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">No usage data yet.</TableCell></TableRow>
          )}
        </TableBody>
      </PaginatedTable>
    </div>
  );
}
