"use client";

import { Card, CardContent } from "@/components/ui/card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";

type TokenByProviderTableProps = {
  data: { provider: string; totalInput: number; totalOutput: number; callCount: number }[];
};

export function TokenByProviderTable({ data }: TokenByProviderTableProps) {
  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="px-5 py-4">
      <h3 className="text-sm font-semibold text-foreground mb-4">Usage by Provider</h3>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No usage data for this period</p>
      ) : (
        <div className="overflow-x-auto">
          <PaginatedTable className="w-full text-sm">
            <TableHeader>
              <TableRow className="border-b border-line text-left">
                <TableHead className="pb-2 pr-4 font-medium text-muted-foreground">Provider</TableHead>
                <TableHead className="pb-2 pr-4 text-right font-medium text-muted-foreground">Input Tokens</TableHead>
                <TableHead className="pb-2 pr-4 text-right font-medium text-muted-foreground">Output Tokens</TableHead>
                <TableHead className="pb-2 pr-4 text-right font-medium text-muted-foreground">Total Tokens</TableHead>
                <TableHead className="pb-2 text-right font-medium text-muted-foreground">Calls</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.provider} className="border-b border-line last:border-0">
                  <TableCell className="py-2 pr-4 font-medium text-foreground capitalize">{row.provider}</TableCell>
                  <TableCell className="py-2 pr-4 text-right text-foreground tabular-nums">
                    {row.totalInput.toLocaleString()}
                  </TableCell>
                  <TableCell className="py-2 pr-4 text-right text-foreground tabular-nums">
                    {row.totalOutput.toLocaleString()}
                  </TableCell>
                  <TableCell className="py-2 pr-4 text-right text-foreground tabular-nums">
                    {(row.totalInput + row.totalOutput).toLocaleString()}
                  </TableCell>
                  <TableCell className="py-2 text-right text-foreground tabular-nums">
                    {row.callCount.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </PaginatedTable>
        </div>
      )}
      </CardContent>
    </Card>
  );
}
