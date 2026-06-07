"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Gantt,
  Willow,
  WillowDark,
  type IApi,
  type ITask,
} from "@svar-ui/react-gantt";
import "@svar-ui/react-gantt/style.css";
import "@/components/workflows/gantt-overrides.css";

import { StatusPill } from "@/components/ui/status-pill";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import {
  workflowStatusToPill,
  type WorkflowStatus,
} from "@/lib/status-adapter";

// ---------------------------------------------------------------------------
// — Workflows index Gantt.
//
// One row per workflow (no tasks). Bar runs from `windowStartUtc` to
// `windowEndUtc`; workflows with no dated tasks fall back to a small window
// anchored on createdAt / targetAtUtc so they still render (WIG-04). Click
// the name in the grid or the bar in the chart → /workflows/[id] (WIG-03).
//
// This is a slim read-only Gantt: no editing, no dependencies, no
// tooltip/context menu / task templates. Just rows + bars + click-to-detail.
// ---------------------------------------------------------------------------

export type WorkflowsIndexRow = {
  id: string;
  name: string;
  status: WorkflowStatus;
  ownerLevel: ScopeLevel | null;
  startUtc: string;
  endUtc: string;
};

export function WorkflowsIndexGantt({ rows }: { rows: WorkflowsIndexRow[] }) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const tasks = React.useMemo<ITask[]>(() => {
    return rows.map((r) => {
      const start = new Date(r.startUtc);
      const end = new Date(r.endUtc);
      const safeEnd = end <= start ? new Date(start.getTime() + 24 * 60 * 60 * 1000) : end;
      return {
        id: r.id,
        text: r.name,
        start,
        end: safeEnd,
        type: "task" as const,
        progress: 0,
      };
    });
  }, [rows]);

  // Click-to-navigate: SVAR `select-task` fires the id (= workflow id).
  const init = React.useCallback(
    (api: IApi) => {
      api.on("select-task", (ev) => {
        const id = ev?.id ? String(ev.id) : undefined;
        if (!id) return;
        router.push(`/workflows/${id}`);
      });
    },
    [router],
  );

  const rowByKey = React.useMemo(() => {
    const m = new Map<string, WorkflowsIndexRow>();
    for (const r of rows) m.set(r.id, r);
    return m;
  }, [rows]);

  // Left-grid columns: name (clickable link), status pill, ownership badge.
  // SVAR Gantt column cells receive `ICellProps = { api, row, column, onaction }`
  // — NOT the task directly. The row is the Gantt's task data (shape ITask +
  // any extra fields). Look up the enriched row via `row.id`.
  type CellProps = { row: { [k: string]: unknown } };
  const columns = React.useMemo(
    () => [
      {
        id: "name",
        header: "Workflow",
        width: 240,
        cell: ({ row }: CellProps) => {
          const r = rowByKey.get(String(row.id));
          if (!r) return <span>{String(row.text ?? "")}</span>;
          return (
            <a
              href={`/workflows/${r.id}`}
              className="text-foreground hover:text-primary truncate"
            >
              {r.name}
            </a>
          );
        },
      },
      {
        id: "status",
        header: "Status",
        width: 110,
        cell: ({ row }: CellProps) => {
          const r = rowByKey.get(String(row.id));
          if (!r) return null;
          return <StatusPill status={workflowStatusToPill(r.status)} />;
        },
      },
      {
        id: "scope",
        header: "Ownership",
        width: 110,
        cell: ({ row }: CellProps) => {
          const r = rowByKey.get(String(row.id));
          if (!r?.ownerLevel) return <span className="text-muted-foreground">—</span>;
          return <ScopeBadge level={r.ownerLevel} />;
        },
      },
    ],
    [rowByKey],
  );

  const Theme = resolvedTheme === "dark" ? WillowDark : Willow;

  if (!mounted) {
    // Client-only render — SVAR draws Dates in the BROWSER timezone, which
    // won't match SSR (hydration mismatch). Gate on a mounted flag.
    return (
      <div className="flex h-[480px] items-center justify-center text-sm text-muted-foreground">
        Loading timeline…
      </div>
    );
  }

  return (
    <div
      className="relative overflow-hidden rounded-control bg-surface"
      data-gantt-shell
      data-gantt-variant="index"
      role="region"
      aria-label="Workflows timeline"
    >
      <Theme>
        <Gantt
          tasks={tasks}
          links={[]}
          columns={columns}
          init={init}
          scales={[
            { unit: "month", step: 1, format: "%F %Y" },
            { unit: "day", step: 1, format: "%d" },
          ]}
          cellWidth={36}
          readonly
        />
      </Theme>
    </div>
  );
}
