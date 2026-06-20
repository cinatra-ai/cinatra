import Link from "next/link";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusPill } from "@/components/ui/status-pill";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import {
  workflowStatusToPill,
  type WorkflowStatus,
} from "@/lib/status-adapter";

// ---------------------------------------------------------------------------
// Workflows index list.
//
// Replaces the removed SVAR index Gantt (cinatra#321). One row per workflow:
// name (link → detail), status pill, ownership badge, and the schedule window
// as a plain start → end date range. Pure server component — no client island,
// no timezone hydration concern (dates are formatted on the server in UTC with
// an explicit `UTC` suffix so SSR and the rendered markup always agree).
// ---------------------------------------------------------------------------

export type WorkflowsIndexRow = {
  id: string;
  name: string;
  status: WorkflowStatus;
  ownerLevel: ScopeLevel | null;
  startUtc: string;
  endUtc: string;
};

// Stable, timezone-free day formatting. The index window is a coarse date
// range (the chart never showed time-of-day), so render the UTC calendar day —
// deterministic between SSR and the DOM, no client mount needed.
const DAY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return DAY_FMT.format(d);
}

function formatWindow(startUtc: string, endUtc: string): string {
  const start = formatDay(startUtc);
  const end = formatDay(endUtc);
  if (start === "—" && end === "—") return "—";
  if (start === end) return start;
  return `${start} → ${end}`;
}

export function WorkflowsIndexList({ rows }: { rows: WorkflowsIndexRow[] }) {
  return (
    <div
      className="overflow-hidden rounded-control bg-surface"
      role="region"
      aria-label="Workflows"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Workflow</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Ownership</TableHead>
            <TableHead>Schedule</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">
                <Link
                  href={`/workflows/${r.id}`}
                  className="text-foreground hover:text-primary"
                >
                  {r.name}
                </Link>
              </TableCell>
              <TableCell>
                <StatusPill status={workflowStatusToPill(r.status)} />
              </TableCell>
              <TableCell>
                {r.ownerLevel ? (
                  <ScopeBadge level={r.ownerLevel} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {formatWindow(r.startUtc, r.endUtc)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
