import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import type { CostBySkillRow } from "../store";
// Same formatter, same reason as the by-agent table (cinatra#2582 / #2641):
// "unknown" for a cost the ledger cannot state, never "$0.00" — and, for a group
// that mixes priced with unpriced rows, the subtotal PLUS what it omits.
import { formatCostCell } from "./cost-by-provider-table";

type CostBySkillTableProps = {
  data: CostBySkillRow[];
};

export function CostBySkillTable({ data }: CostBySkillTableProps) {
  return (
    <div className="overflow-auto">
      <PaginatedTable className="w-full text-sm">
        <TableHeader>
          <TableRow className="border-b border-line text-left text-muted-foreground">
            <TableHead className="pb-2 pr-4 font-medium">Skill</TableHead>
            <TableHead className="pb-2 pr-4 font-medium text-right">Cost</TableHead>
            <TableHead className="pb-2 font-medium text-right">Calls</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((row, i) => (
            <TableRow key={i} className="border-b border-line/50 text-foreground">
              <TableCell className="py-2 pr-4">{row.skillLabel ?? "(no skill)"}</TableCell>
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
