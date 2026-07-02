"use client";

// workflow-status portlet. Read-only status summary in two modes:
//   - single (workflowId input): the workflow + its tasks, each with a StatusPill.
//   - list (projectId input): the project's workflows, each with a StatusPill.
// The full workflow management surface (task list + lifecycle + target date)
// stays on /workflows/[id]. Scope + project-read authz enforced server-side by
// the loaders.
import { useEffect, useState, useTransition } from "react";
import { StatusPill } from "@/components/ui/status-pill";
import {
  workflowStatusToPill,
  workflowTaskStatusToPill,
  type WorkflowStatus,
  type WorkflowTaskStatus,
} from "@/lib/status-adapter";
import {
  loadWorkflowStatusSingle,
  loadWorkflowStatusList,
  type PortletWorkflowSingle,
  type PortletWorkflowList,
} from "@/lib/dashboards/portlet-loaders";
import type { PortletComponentProps } from "./types";

type State =
  | { kind: "single"; data: PortletWorkflowSingle | null }
  | { kind: "list"; data: PortletWorkflowList }
  | { kind: "idle" };

export function WorkflowStatusPortlet({ inputs }: PortletComponentProps) {
  const workflowId = typeof inputs.workflowId === "string" ? inputs.workflowId : null;
  const projectId = typeof inputs.projectId === "string" ? inputs.projectId : null;
  const [state, setState] = useState<State>({ kind: "idle" });
  const [pending, start] = useTransition();

  useEffect(() => {
    if (workflowId) {
      start(async () => setState({ kind: "single", data: await loadWorkflowStatusSingle({ workflowId }) }));
      return;
    }
    if (projectId) {
      start(async () => setState({ kind: "list", data: await loadWorkflowStatusList({ projectId }) }));
      return;
    }
    setState({ kind: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, projectId]);

  if (state.kind === "idle") return <p className="text-sm text-muted-foreground">Select a workflow or project.</p>;
  if (pending) return <p className="text-sm text-muted-foreground">Loading…</p>;

  if (state.kind === "single") {
    if (!state.data) return <p className="text-sm text-muted-foreground">Not found or not accessible.</p>;
    const wf = state.data;
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate text-sm font-medium text-foreground">{wf.name}</p>
          <StatusPill status={workflowStatusToPill(wf.status as WorkflowStatus)} />
        </div>
        {wf.tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {wf.tasks.map((t) => (
              <li key={t.key} className="flex items-center justify-between gap-3">
                <span className="truncate text-sm text-foreground">{t.title}</span>
                <StatusPill status={workflowTaskStatusToPill(t.status as WorkflowTaskStatus)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // list mode
  if (state.data.workflows.length === 0) return <p className="text-sm text-muted-foreground">No workflows.</p>;
  return (
    <ul className="flex flex-col gap-1.5">
      {state.data.workflows.map((w) => (
        <li key={w.workflowId} className="flex items-center justify-between gap-3">
          <span className="truncate text-sm text-foreground">{w.name}</span>
          <StatusPill status={workflowStatusToPill(w.status as WorkflowStatus)} />
        </li>
      ))}
    </ul>
  );
}
