"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/cinatra-toast";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { triggerAgentRun } from "./run-actions";

type RunAgentButtonProps = {
  runId: string;
  templateSlug: string;
  agentName: string;
  allStepsComplete: boolean;
  /**
   * The current run.status from the server. Button is rendered only when
   * this is "pending_input" — every other status (queued, running,
   * pending_approval, completed, failed) means triggerAgentRun would
   * reject anyway, so we hide the button to keep the UI honest.
   */
  runStatus: string;
  /**
   * Where the reader goes once the run is triggered.
   *
   * REQUIRED, AND DELIBERATELY (cinatra#3693). This used to be optional over a
   * bare `/agents/<slug>/<run>/data` fallback, which is an address with no scope
   * in it: a run launched from a team, a project or an organization would have
   * left its scope the moment it started, with nothing said. The one caller has
   * always passed a scoped destination, so the fallback was unreachable — and a
   * second caller added without one would have escaped a scope silently. The
   * caller that knows the scope is the caller that must name the destination.
   */
  redirectTo: string;
};

export function RunAgentButton({
  runId,
  templateSlug,
  agentName,
  allStepsComplete,
  runStatus,
  redirectTo,
}: RunAgentButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  // Two-gate visibility: setup must be complete AND the run must still be
  // in pending_input. Either condition false → render nothing.
  if (!allStepsComplete) return null;
  if (runStatus !== "pending_input") return null;

  function handleConfirm() {
    startTransition(async () => {
      try {
        const result = await triggerAgentRun({ runId, templateSlug });
        if (!result.ok) {
          toast.error("Couldn't start the agent. Try again.");
          setOpen(false);
          return;
        }
        // Success: the caller's own destination, which carries the scope the run
        // was launched from (cinatra#3693).
        router.push(redirectTo);
      } catch {
        toast.error("Couldn't start the agent. Try again.");
        setOpen(false);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button disabled={isPending} aria-label="Run agent">
          {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Run agent
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Run {agentName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This will start the agent with your configured inputs.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Don&apos;t run</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm} disabled={isPending}>
            Run agent
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
