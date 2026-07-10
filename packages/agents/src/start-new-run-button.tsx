"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/cinatra-toast";
import { createAndTriggerRun } from "./run-actions";

export type StartNewRunButtonProps = {
  agentId: string;
};

export function StartNewRunButton({ agentId }: StartNewRunButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleClick = () => {
    startTransition(async () => {
      const result = await createAndTriggerRun({ templateSlug: agentId });
      if (result.ok) {
        router.push(`/agents/${agentId}/${encodeURIComponent(result.runId)}`);
      } else {
        toast.error(result.error ?? "Could not create a new run.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Button onClick={handleClick} disabled={isPending}>
        {isPending ? "Starting…" : "Start new run"}
      </Button>
    </div>
  );
}
