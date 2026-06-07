import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import type { CostBySkillRow } from "../store";

type CostBySkillTableProps = {
  data: CostBySkillRow[];
};

function formatUsd(v: number | null): string {
  if (v === null || v === undefined) return "$0.00";
  return `$${v.toFixed(4)}`;
}

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
              <TableCell className="py-2 pr-4 text-right">{formatUsd(row.totalCost)}</TableCell>
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
