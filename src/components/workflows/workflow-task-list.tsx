"use client";

import * as React from "react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import {
  WorkflowTaskDetail,
  type WorkflowTaskDetailRow,
} from "@/components/workflows/workflow-task-detail";
import { workflowTaskStatusToPill } from "@/lib/status-adapter";

// ---------------------------------------------------------------------------
// Workflow task list.
//
// Replaces the removed SVAR detail Gantt (cinatra#321). A read-only table of
// the workflow's tasks in chronological order. Each row surfaces the same
// fields the Gantt's grid + bars carried (key, title, type, status, planned
// window, due, dependency count) and clicking a row opens the existing
// `WorkflowTaskDetail` Sheet — reused verbatim — for the full task detail.
//
// The interactive Gantt edit surface (drag-to-reschedule, dependency
// add/remove, delete-task) and the CPM / planned-vs-actual / DST-cascade
// VISUALIZATION are intentionally dropped per #321; workflow target dates and
// the whole `packages/workflows` runtime engine stay. Lifecycle + target-date
// controls are rendered into the toolbar via `extraToolbarItems`.
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<WorkflowTaskDetailRow["type"], string> = {
  checkpoint: "Checkpoint",
  agent_task: "Agent task",
  approval: "Approval",
  manual: "Manual",
  notification: "Notification",
  wait: "Wait",
};

function formatDay(iso: string | null, tz?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(tz ? { timeZone: tz } : {}),
  });
}

export type WorkflowTaskListProps = {
  taskRows: WorkflowTaskDetailRow[];
  /** Workflow release/anchor timezone (IANA) for localized date display. */
  displayTz?: string;
  /**
   * Lifecycle controls + target-date control. Rendered in the section toolbar
   * (the same slot the Gantt section used) so the page wiring is unchanged.
   */
  extraToolbarItems?: React.ReactNode;
};

export function WorkflowTaskList({
  taskRows,
  displayTz,
  extraToolbarItems,
}: WorkflowTaskListProps) {
  const [selectedKey, setSelectedKey] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState(false);

  const taskByKey = React.useMemo(() => {
    const m = new Map<string, WorkflowTaskDetailRow>();
    for (const t of taskRows) m.set(t.key, t);
    return m;
  }, [taskRows]);

  const handleSelect = React.useCallback((key: string) => {
    setSelectedKey(key);
    setOpen(true);
  }, []);

  const handleOpenChange = React.useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setSelectedKey(null);
  }, []);

  // Resolve the selected task during render. If the selected key vanished after
  // a server revalidation (the task was deleted upstream), `selectedTask` is
  // null and the Sheet shows the empty state — no state-syncing effect needed.
  const selectedTask =
    selectedKey !== null ? taskByKey.get(selectedKey) ?? null : null;
  const sheetOpen = open && selectedTask !== null;

  return (
    <div className="flex flex-col gap-3" data-testid="workflow-task-list">
      {/* Toolbar: lifecycle controls + target-date control sit on the right.
          The Gantt-era view-switcher / Today / Fullscreen are gone with the
          chart. */}
      <Toolbar aria-label="Workflow controls">
        <ToolbarGroup className="ml-auto">{extraToolbarItems}</ToolbarGroup>
      </Toolbar>

      <div className="soft-panel">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>Due</TableHead>
              <TableHead className="text-right">Depends on</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {taskRows.map((t) => (
              <TableRow key={t.key}>
                {/* A real Button in the Task cell owns the open-detail
                    interaction — keeping the <tr> a valid table row (no
                    role="button" on a <tr>, which breaks table semantics). */}
                <TableCell className="font-medium">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-task-row={t.key}
                    className="h-auto w-full justify-start gap-2 px-1 py-1 font-medium"
                    onClick={() => handleSelect(t.key)}
                  >
                    <span className="text-foreground">{t.title}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {t.key}
                    </span>
                  </Button>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{TYPE_LABEL[t.type]}</Badge>
                </TableCell>
                <TableCell>
                  <StatusPill status={workflowTaskStatusToPill(t.status)} />
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {formatDay(t.plannedStartUtc, displayTz)}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {formatDay(t.dueUtc, displayTz)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {t.dependsOn.length > 0 ? t.dependsOn.length : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <WorkflowTaskDetail
        task={selectedTask}
        open={sheetOpen}
        onOpenChange={handleOpenChange}
        displayTz={displayTz}
      />
    </div>
  );
}
