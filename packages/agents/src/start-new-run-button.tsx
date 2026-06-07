"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { createAndTriggerRun } from "./run-actions";

export type StartNewRunButtonProps = {
  agentId: string;
};

export function StartNewRunButton({ agentId }: StartNewRunButtonProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await createAndTriggerRun({ templateSlug: agentId });
      if (result.ok) {
        router.push(`/agents/${agentId}/${encodeURIComponent(result.runId)}`);
      } else {
        setError(result.error ?? "Could not create a new run.");
      }
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Button onClick={handleClick} disabled={isPending}>
        {isPending ? "Starting…" : "Start new run"}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
