"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";

type RecentEventsLogProps = {
  events: Record<string, unknown>[];
  currentProvider?: string;
  providers: string[];
};

// Radix Select disallows empty-string SelectItem values; use a sentinel for the
// "All providers" choice and translate at the boundary so the parent contract
// (currentProvider="" or undefined → "all") stays unchanged.
const ALL_PROVIDERS_SENTINEL = "__all__";

function formatUsd(v: unknown): string {
  const n = Number(v);
  if (!v || isNaN(n)) return "-";
  return `$${n.toFixed(6)}`;
}

export function RecentEventsLog({ events, currentProvider, providers }: RecentEventsLogProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleProviderFilter(provider: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (provider === "") {
      params.delete("provider");
    } else {
      params.set("provider", provider);
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <Card className="border-line bg-surface backdrop-blur-none">
      <CardContent className="px-5 py-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Recent Events</h3>
        <Select
          value={currentProvider && currentProvider !== "" ? currentProvider : ALL_PROVIDERS_SENTINEL}
          onValueChange={(v) => handleProviderFilter(v === ALL_PROVIDERS_SENTINEL ? "" : v)}
        >
          <SelectTrigger className="rounded-control border border-line bg-surface px-2 py-1 text-xs text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROVIDERS_SENTINEL}>All providers</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="mt-4 overflow-auto">
        <PaginatedTable className="w-full text-xs">
          <TableHeader>
            <TableRow className="border-b border-line text-left text-muted-foreground">
              <TableHead className="pb-2 pr-3 font-medium">Time</TableHead>
              <TableHead className="pb-2 pr-3 font-medium">Provider</TableHead>
              <TableHead className="pb-2 pr-3 font-medium">Model / Plan</TableHead>
              <TableHead className="pb-2 pr-3 font-medium">Agent</TableHead>
              <TableHead className="pb-2 pr-3 font-medium text-right">In</TableHead>
              <TableHead className="pb-2 pr-3 font-medium text-right">Out</TableHead>
              <TableHead className="pb-2 font-medium text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((ev, i) => (
              <TableRow key={i} className="border-b border-line/50 text-foreground">
                <TableCell className="py-1.5 pr-3 whitespace-nowrap">
                  {ev.occurred_at ? format(new Date(ev.occurred_at as string), "MMM d HH:mm") : "-"}
                </TableCell>
                <TableCell className="py-1.5 pr-3">{String(ev.provider ?? "-")}</TableCell>
                <TableCell className="py-1.5 pr-3">{String(ev.model ?? ev.operation ?? "-")}</TableCell>
                <TableCell className="py-1.5 pr-3">{String(ev.agent_label ?? "-")}</TableCell>
                <TableCell className="py-1.5 pr-3 text-right">{Number(ev.input_tokens ?? 0).toLocaleString()}</TableCell>
                <TableCell className="py-1.5 pr-3 text-right">{Number(ev.output_tokens ?? 0).toLocaleString()}</TableCell>
                <TableCell className="py-1.5 text-right">{formatUsd(ev.cost_usd)}</TableCell>
              </TableRow>
            ))}
            {events.length === 0 && (
              <TableRow><TableCell colSpan={7} className="py-8 text-center text-muted-foreground">No events recorded yet.</TableCell></TableRow>
            )}
          </TableBody>
        </PaginatedTable>
      </div>
      </CardContent>
    </Card>
  );
}
