"use client";

import { useTransition } from "react";
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { toast } from "@/lib/cinatra-toast";
import { retryRemoteEffectAction } from "@/components/data-safety/remote-effect-actions";

// Platform-admin retry button for a failed/pending remote
// effect. Only rendered for platform_admin actors (the parent panel gates
// visibility); the action re-enforces. Today most retries return "unsupported"
// (no connector restore adapter wired yet) — surfaced honestly via toast.
export type RetryRemoteEffectButtonProps = { attemptId: string };

export function RetryRemoteEffectButton({ attemptId }: RetryRemoteEffectButtonProps) {
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      const result = await retryRemoteEffectAction({ attemptId });
      if (result.ok) {
        toast.success(`Retry queued (${result.data?.status ?? "pending"})`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button variant="outline" size="xs" onClick={onClick} disabled={pending}>
      <RotateCw data-icon="inline-start" />
      {pending ? "Retrying…" : "Retry"}
    </Button>
  );
}
