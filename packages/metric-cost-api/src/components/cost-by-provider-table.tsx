import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import type { CostByProviderRow, LegacyCostEntry } from "../store";

type CostByProviderTableProps = {
  data: CostByProviderRow[];
  legacyCosts: LegacyCostEntry[];
};

function formatUsd(v: number | null): string {
  if (v === null || v === undefined) return "$0.00";
  return `$${v.toFixed(4)}`;
}

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
              <TableCell className="py-2 pr-4">{row.model ?? "(unknown)"}</TableCell>
              <TableCell className="py-2 pr-4 text-right">{formatUsd(row.totalCost)}</TableCell>
              <TableCell className="py-2 pr-4 text-right">{row.callCount}</TableCell>
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
