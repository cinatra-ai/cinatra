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

/**
 * Encodes a template slug for use as a URL path segment, preserving any
 * forward slashes as path separators. A slug such as "vendor/package" becomes
 * "vendor/package" in the path (each segment individually percent-encoded),
 * not "vendor%2Fpackage" which would break the [vendor]/[packageName] routing.
 */
function encodeSlug(slug: string): string {
  return slug.split("/").map(encodeURIComponent).join("/");
}

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
  /** After triggering, navigate here instead of the default /data route. */
  redirectTo?: string;
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
        // Success: navigate to caller-specified route or Results tab
        router.push(
          redirectTo ?? `/agents/${encodeSlug(templateSlug)}/${encodeURIComponent(runId)}/data`,
        );
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
