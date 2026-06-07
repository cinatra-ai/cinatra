import type { Metadata } from "next";
import Link from "next/link";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { ScopeBadge, type ScopeLevel } from "@/components/scope-badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { Plus, TriangleAlertIcon } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { buildWorkflowActorFromSession } from "@/lib/workflow-actor";
import {
  listWorkflows,
  listWorkflowWindows,
} from "@cinatra-ai/workflows/store";
import { findStuckTasks } from "@cinatra-ai/workflows/engine";
import { filterReadable } from "@cinatra-ai/workflows/scope";
import { type WorkflowStatus } from "@/lib/status-adapter";
import {
  WorkflowsIndexGantt,
  type WorkflowsIndexRow,
} from "@/components/workflows/workflows-index-gantt";

export const metadata: Metadata = { title: "Workflows" };

// Fallback: workflows with no dated tasks still need a visible bar. We use
// `targetAtUtc` (the workflow's release/anchor) if present, otherwise
// `createdAt` → `createdAt + 1 day`.
const DAY_MS = 24 * 60 * 60 * 1000;

export default async function WorkflowsPage() {
  const { actor, orgId } = await buildWorkflowActorFromSession();
  const rows = orgId ? filterReadable(await listWorkflows({ orgId }), actor) : [];

  // Operator stuck-task surface: tasks running past the threshold, scoped in
  // SQL to this org's readable workflow ids (tenant boundary + smaller scan).
  const wfNameById = new Map(rows.map((w) => [w.id, w.name]));
  const stuck = rows.length > 0 ? await findStuckTasks([...wfNameById.keys()]) : [];

  // Single GROUP BY query over workflow_task — no N+1.
  const windows = rows.length > 0 ? await listWorkflowWindows(rows.map((w) => w.id)) : [];
  const windowById = new Map(windows.map((w) => [w.workflowId, w]));

  const ganttRows: WorkflowsIndexRow[] = rows.map((w) => {
    const win = windowById.get(w.id);
    let startUtc = win?.windowStartUtc ?? null;
    let endUtc = win?.windowEndUtc ?? null;
    if (!startUtc || !endUtc) {
      // Fallback — anchor on target / createdAt so untimed workflows
      // still render in the index Gantt.
      const anchor = w.targetAtUtc ?? w.createdAt;
      startUtc = anchor;
      endUtc = new Date(anchor.getTime() + DAY_MS);
    }
    return {
      id: w.id,
      name: w.name,
      status: w.status as WorkflowStatus,
      ownerLevel: (w.ownerLevel as ScopeLevel | null) ?? null,
      startUtc: startUtc.toISOString(),
      endUtc: endUtc.toISOString(),
    };
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Workflows"
        description="AI-assisted, calendar-driven workflows."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Toolbar aria-label="Workflows actions">
          <ToolbarGroup>
            <Button asChild size="sm">
              <Link href="/chat?mode=create-workflow">
                <Plus data-icon="inline-start" aria-hidden="true" />
                Create workflow
              </Link>
            </Button>
          </ToolbarGroup>
        </Toolbar>
        {stuck.length > 0 && (
          <Alert data-testid="stuck-tasks-alert">
            <TriangleAlertIcon />
            <AlertTitle>
              {stuck.length} stuck task{stuck.length === 1 ? "" : "s"}
            </AlertTitle>
            <AlertDescription>
              <ul className="flex flex-col gap-1">
                {stuck.map((s) => (
                  <li key={s.taskId}>
                    <Link href={`/workflows/${s.workflowId}`} className="text-foreground hover:text-primary">
                      {wfNameById.get(s.workflowId) ?? s.workflowId}
                    </Link>{" "}
                    — {s.type} running for {formatDistanceToNow(new Date(s.sinceUtc))}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {ganttRows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No workflows yet</EmptyTitle>
              <EmptyDescription>
                Describe a workflow in chat to create your first one, then manage it here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <WorkflowsIndexGantt rows={ganttRows} />
        )}
      </PageContent>
    </Main>
  );
}
