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
//     by an unknown multiple.
// ---------------------------------------------------------------------------

/** Dollars, or the word "unknown" — never a number the ledger cannot back. */
export function formatUsd(v: number | null): string {
  if (v === null || v === undefined) return "unknown";
  return `$${v.toFixed(4)}`;
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
              <TableCell className="py-2 pr-4 text-right">{formatUsd(row.totalCost)}</TableCell>
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
