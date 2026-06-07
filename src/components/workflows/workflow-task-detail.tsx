"use client";

import * as React from "react";

import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status-pill";
import { workflowTaskStatusToPill, type WorkflowTaskStatus } from "@/lib/status-adapter";

// ---------------------------------------------------------------------------
// Detail panel surfaced when a Gantt bar is clicked. Pure presenter — the
// page owns `selectedKey` state and feeds the underlying task row through.
//
// Linking out: the `agentPackage` string is rendered as text. There is no
// per-package detail route in this app today, so a deep link would 404. If
// `/configuration/extensions/<pkg>` lands later, wrap the package text in
// a Next `<Link>` here.
// ---------------------------------------------------------------------------

export type WorkflowTaskDetailRow = {
  key: string;
  title: string;
  // Mirrors the workflow_task.type domain.
  type: "checkpoint" | "agent_task" | "approval" | "manual" | "notification" | "wait";
  status: WorkflowTaskStatus;
  plannedStartUtc: string | null;
  plannedEndUtc: string | null;
  dueUtc: string | null;
  actualStartUtc: string | null;
  actualEndUtc: string | null;
  agentPackage: string | null;
  /** Upstream task keys this task depends on. */
  dependsOn: string[];
  /** Downstream task keys that depend on this task. */
  blocks: string[];
  /** Approval-only — required scope level + decision context. */
  approvalScope: string | null;
  approvalStatus: "pending" | "granted" | "rejected" | "needs_revision" | null;
};

const TYPE_LABEL: Record<WorkflowTaskDetailRow["type"], string> = {
  checkpoint: "Checkpoint",
  agent_task: "Agent task",
  approval: "Approval",
  manual: "Manual",
  notification: "Notification",
  wait: "Wait",
};

// `tz` = the workflow release/anchor timezone (IANA). Dates localize to it via
// Intl's `timeZone` option; falls back to browser tz when unset.
function formatDate(iso: string | null, tz?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    ...(tz ? { timeZone: tz } : {}),
  });
}

export type WorkflowTaskDetailProps = {
  task: WorkflowTaskDetailRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workflow release/anchor timezone (IANA) for localized date display. */
  displayTz?: string;
  /** Optional callback for the future "open agent run" affordance. */
  onJumpToAgent?: (taskKey: string) => void;
};

export function WorkflowTaskDetail({ task, open, onOpenChange, displayTz }: WorkflowTaskDetailProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        {task ? (
          <>
            <SheetHeader>
              <SheetTitle className="flex flex-wrap items-center gap-2 text-balance">
                <span className="text-lg font-semibold leading-snug">{task.title}</span>
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{TYPE_LABEL[task.type]}</Badge>
                <StatusPill status={workflowTaskStatusToPill(task.status)} />
                <span className="text-xs font-mono text-muted-foreground">{task.key}</span>
              </SheetDescription>
            </SheetHeader>

            <div className="grid gap-4 px-4 pb-4 text-sm">
              {task.type === "agent_task" && (
                <Section title="Agent">
                  {task.agentPackage ? (
                    <span className="font-mono text-xs">{task.agentPackage}</span>
                  ) : (
                    <span className="text-muted-foreground">Not configured</span>
                  )}
                </Section>
              )}

              {task.type === "approval" && (
                <Section title="Approval">
                  <div className="flex flex-col gap-1">
                    <div>
                      <span className="text-muted-foreground">Required scope:</span>{" "}
                      <span>{task.approvalScope ?? "organization"}</span>
                    </div>
                    {task.approvalStatus && (
                      <div>
                        <span className="text-muted-foreground">Decision:</span>{" "}
                        <span className="capitalize">{task.approvalStatus.replace(/_/g, " ")}</span>
                      </div>
                    )}
                  </div>
                </Section>
              )}

              <Section title="Schedule">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
                  <Field label="Planned start" value={formatDate(task.plannedStartUtc, displayTz)} />
                  <Field label="Planned end" value={formatDate(task.plannedEndUtc, displayTz)} />
                  <Field label="Due" value={formatDate(task.dueUtc, displayTz)} />
                  {(task.actualStartUtc || task.actualEndUtc) && (
                    <>
                      <Field label="Actual start" value={formatDate(task.actualStartUtc, displayTz)} />
                      <Field label="Actual end" value={formatDate(task.actualEndUtc, displayTz)} />
                    </>
                  )}
                </dl>
              </Section>

              {(task.dependsOn.length > 0 || task.blocks.length > 0) && (
                <Section title="Dependencies">
                  <div className="flex flex-col gap-2">
                    {task.dependsOn.length > 0 && (
                      <div>
                        <div className="text-xs text-muted-foreground">Depends on</div>
                        <div className="flex flex-wrap gap-1">
                          {task.dependsOn.map((d) => (
                            <Badge key={d} variant="outline" className="font-mono text-[10px]">
                              {d}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                    {task.blocks.length > 0 && (
                      <div>
                        <div className="text-xs text-muted-foreground">Blocks</div>
                        <div className="flex flex-wrap gap-1">
                          {task.blocks.map((d) => (
                            <Badge key={d} variant="outline" className="font-mono text-[10px]">
                              {d}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </Section>
              )}
            </div>

            <SheetFooter>
              <SheetClose asChild>
                <Button variant="secondary">Close</Button>
              </SheetClose>
            </SheetFooter>
          </>
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
            Select a task to see details.
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      <div className="text-sm text-foreground">{children}</div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </>
  );
}
