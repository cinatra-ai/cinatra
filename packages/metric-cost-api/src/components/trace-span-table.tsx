import "server-only";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginatedTable } from "@/components/ui/paginated-table";
import { Badge } from "@/components/ui/badge";
import type { TraceSpanRow } from "../store";

// ---------------------------------------------------------------------------
// TraceSpanTable.
// "tree" mode: span tree with indented rows based on parent_span_id within a
//              single run (typically 5–50 spans).
// "recent" mode: flat list of most recent spans across all runs.
// Styling: shadcn-admin tokens only (text-foreground, bg-surface, border-line,
// soft-panel). No raw Tailwind palette classes.
// ---------------------------------------------------------------------------

type TraceSpanTableProps = {
  spans: TraceSpanRow[];
  mode: "tree" | "recent";
};

type TreeNode = TraceSpanRow & { depth: number; children: TreeNode[] };

function buildTree(spans: TraceSpanRow[]): TreeNode[] {
  // Graceful fallback: when parentSpanId is absent or does not match any span in
  // the result set (e.g. cross-process spans, or spans from runs missing linked
  // parent spans), the span becomes a root node with depth=0. The result is a
  // flat list — still useful; no special handling needed.
  const byId = new Map<string, TreeNode>();
  for (const s of spans) {
    byId.set(s.spanId, { ...s, depth: 0, children: [] });
  }
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentSpanId && byId.has(node.parentSpanId)) {
      const parent = byId.get(node.parentSpanId)!;
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Propagate depth to children (second pass — parent depth may have been
  // updated after child was attached).
  function reflow(node: TreeNode, depth: number) {
    node.depth = depth;
    for (const c of node.children) reflow(c, depth + 1);
  }
  for (const r of roots) reflow(r, 0);
  return roots;
}

function flattenTree(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  function walk(n: TreeNode) {
    out.push(n);
    for (const c of n.children) walk(c);
  }
  for (const r of roots) walk(r);
  return out;
}

function statusBadgeVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "ok") return "default";
  if (status === "error") return "destructive";
  return "secondary";
}

export function TraceSpanTable({ spans, mode }: TraceSpanTableProps) {
  const rows =
    mode === "tree"
      ? flattenTree(buildTree(spans))
      : spans.map((s) => ({ ...s, depth: 0, children: [] as TreeNode[] }));

  return (
      <PaginatedTable>
        <TableHeader>
          <TableRow className="border-line">
            <TableHead className="text-foreground">Name</TableHead>
            <TableHead className="text-foreground">Service</TableHead>
            <TableHead className="text-foreground">Status</TableHead>
            <TableHead className="text-right text-foreground">Duration</TableHead>
            <TableHead className="text-foreground">Started</TableHead>
            {mode === "recent" && (
              <TableHead className="text-foreground">Run</TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={`${row.traceId}-${row.spanId}`} className="border-line">
              <TableCell className="text-foreground">
                <span
                  className="font-mono text-xs"
                  style={{ paddingLeft: `${row.depth * 16}px` }}
                >
                  {row.depth > 0 ? "↳ " : ""}{row.name}
                </span>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.service}</TableCell>
              <TableCell>
                <Badge variant={statusBadgeVariant(row.status)}>{row.status}</Badge>
              </TableCell>
              <TableCell className="text-right font-mono text-xs text-foreground">
                {row.durationMs !== null ? `${row.durationMs} ms` : "—"}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">
                {row.startedAt.toISOString()}
              </TableCell>
              {mode === "recent" && (
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {row.agentRunId ?? "—"}
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </PaginatedTable>
  );
}
