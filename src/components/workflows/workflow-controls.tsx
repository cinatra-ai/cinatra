"use client";

// Workflow lifecycle controls (Pause / Resume / Cancel).
// Renders into the workflow detail PageHeader actions slot. Server-actions are
// passed in pre-bound to the workflowId; the actions re-check `canManage`
// server-side — `canManage` here gates display only (UX hint), not security.

import { useState, useTransition } from "react";
import { PauseIcon, PlayIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "@/lib/cinatra-toast";
import type { LifecycleActionResult } from "@/app/workflows/[workflowId]/actions";

type Props = {
  status: string;
  canManage: boolean;
  startAction: () => Promise<LifecycleActionResult>;
  pauseAction: () => Promise<LifecycleActionResult>;
  resumeAction: () => Promise<LifecycleActionResult>;
  cancelAction: () => Promise<LifecycleActionResult>;
  /**
   * Visual variant. Default `"page-header"` (Button variants, used
   * in the PageHeader actions slot). `"toolbar"` emits
   * `<ToolbarButton>` wrapped in a `<ToolbarGroup>` so the controls match the
   * Section's other toolbar items.
   */
  variant?: "page-header" | "toolbar";
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function WorkflowControls({
  status,
  canManage,
  startAction,
  pauseAction,
  resumeAction,
  cancelAction,
  variant = "page-header",
}: Props) {
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  if (!canManage) return null;
  if (TERMINAL.has(status)) return null;

  function runAction(action: () => Promise<LifecycleActionResult>, successMessage: string) {
    startTransition(async () => {
      try {
        const r = await action();
        if (r.ok) toast.success(successMessage);
        else toast.error(`Action rejected${r.reason ? `: ${r.reason}` : ""}`);
      } catch {
        toast.error("Could not update the workflow.");
      }
    });
  }

  const isToolbar = variant === "toolbar";

  const startBtn = status === "draft" && (
    isToolbar ? (
      <ToolbarButton
        type="button"
        data-testid="workflow-start"
        disabled={pending}
        onClick={() => runAction(startAction, "Workflow started")}
      >
        <PlayIcon data-icon="inline-start" />
        Start
      </ToolbarButton>
    ) : (
      <Button
        size="sm"
        data-testid="workflow-start"
        disabled={pending}
        onClick={() => runAction(startAction, "Workflow started")}
      >
        <PlayIcon data-icon="inline-start" />
        Start
      </Button>
    )
  );

  const pauseBtn = status === "active" && (
    isToolbar ? (
      <ToolbarButton
        type="button"
        data-testid="workflow-pause"
        disabled={pending}
        onClick={() => runAction(pauseAction, "Workflow paused")}
      >
        <PauseIcon data-icon="inline-start" />
        Pause
      </ToolbarButton>
    ) : (
      <Button
        variant="outline"
        size="sm"
        data-testid="workflow-pause"
        disabled={pending}
        onClick={() => runAction(pauseAction, "Workflow paused")}
      >
        <PauseIcon data-icon="inline-start" />
        Pause
      </Button>
    )
  );

  const resumeBtn = status === "paused" && (
    isToolbar ? (
      <ToolbarButton
        type="button"
        data-testid="workflow-resume"
        disabled={pending}
        onClick={() => runAction(resumeAction, "Workflow resumed")}
      >
        <PlayIcon data-icon="inline-start" />
        Resume
      </ToolbarButton>
    ) : (
      <Button
        variant="outline"
        size="sm"
        data-testid="workflow-resume"
        disabled={pending}
        onClick={() => runAction(resumeAction, "Workflow resumed")}
      >
        <PlayIcon data-icon="inline-start" />
        Resume
      </Button>
    )
  );

  const cancelTrigger = isToolbar ? (
    <ToolbarButton type="button" data-testid="workflow-cancel-trigger" disabled={pending}>
      <XIcon data-icon="inline-start" />
      Cancel workflow
    </ToolbarButton>
  ) : (
    <Button variant="outline" size="sm" data-testid="workflow-cancel-trigger" disabled={pending}>
      <XIcon data-icon="inline-start" />
      Cancel workflow
    </Button>
  );

  const cancelBlock = status !== "draft" && (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogTrigger asChild>{cancelTrigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this workflow?</AlertDialogTitle>
          <AlertDialogDescription>
            All non-terminal tasks will be cancelled and any in-flight child agent runs will be stopped.
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Keep running</AlertDialogCancel>
          <AlertDialogAction
            data-testid="workflow-cancel-confirm"
            onClick={(e) => {
              e.preventDefault();
              runAction(cancelAction, "Workflow cancelled");
              setConfirmOpen(false);
            }}
          >
            Cancel workflow
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (isToolbar) {
    return (
      <ToolbarGroup>
        {startBtn}
        {pauseBtn}
        {resumeBtn}
        {cancelBlock}
      </ToolbarGroup>
    );
  }

  return (
    <>
      {startBtn}
      {pauseBtn}
      {resumeBtn}
      {cancelBlock}
    </>
  );
}
