import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import type { CostByAgentRow } from "../store";
// The ONE cost-cell formatter (cinatra#2582 / #2641). Imported rather than
// re-declared: this table used to print "$0.00" for a group whose cost the
// ledger does not know, and cinatra#2641 puts a NAMED agent behind unpriced
// spend for the first time — `blog-post-image`, one row per billed image. An
// agent that ALSO does priced work lands in a mixed group, whose `SUM(cost_usd)`
// is a partial number; `formatCostCell` says how many rows it leaves out.
import { formatCostCell } from "./cost-by-provider-table";

type CostByAgentTableProps = {
  data: CostByAgentRow[];
};

export function CostByAgentTable({ data }: CostByAgentTableProps) {
  return (
    <div className="overflow-auto">
      <PaginatedTable className="w-full text-sm">
        <TableHeader>
          <TableRow className="border-b border-line text-left text-muted-foreground">
            <TableHead className="pb-2 pr-4 font-medium">Agent / Skill</TableHead>
            <TableHead className="pb-2 pr-4 font-medium text-right">Cost</TableHead>
            <TableHead className="pb-2 font-medium text-right">Calls</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row, i) => (
            <TableRow key={i} className="border-b border-line/50 text-foreground">
              <TableCell className="py-2 pr-4">{row.agentLabel ?? "(no agent context)"}</TableCell>
              <TableCell className="py-2 pr-4 text-right">{formatCostCell(row.totalCost, row.unknownCostCount)}</TableCell>
              <TableCell className="py-2 text-right">{row.callCount}</TableCell>
            </TableRow>
          ))}
          {data.length === 0 && (
            <TableRow><TableCell colSpan={3} className="py-8 text-center text-muted-foreground">No usage data yet.</TableCell></TableRow>
          )}
        </TableBody>
      </PaginatedTable>
    </div>
  );
}
