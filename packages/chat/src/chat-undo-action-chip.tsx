"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { undoDeepLink } from "@/components/data-safety/undo-toast";
import { recentUndoableChangeSetForRunAction } from "./undo-actions";

// Inline "Undo last action" chip under an agent_run card.
// Bounded polling: a mount check plus a few
// short retries within the undo window — NOT a live/tight loop. When a recent
// CLOSED restorable change-set produced by the run appears, render a link to
// the URL-addressable restore modal (?openRestore=1),
// which runs the existing restore confirm + per-event authz on open/confirm.
const POLL_DELAYS_MS = [0, 3000, 6000]; // mount, +3s, +6s, then stop.

export type UndoActionChipProps = { runId: string };

export function UndoActionChip({ runId }: UndoActionChipProps) {
  const [changeSetId, setChangeSetId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const delay of POLL_DELAYS_MS) {
      timers.push(
        setTimeout(async () => {
          if (cancelled || changeSetId) return;
          try {
            const result = await recentUndoableChangeSetForRunAction({ runId });
            if (!cancelled && result) setChangeSetId(result.changeSetId);
          } catch {
            // Best-effort affordance — never throw into the chat render.
          }
        }, delay),
      );
    }
    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
    };
    // changeSetId intentionally omitted: once found we stop (the guard above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId]);

  if (!changeSetId) return null;

  return (
    <div className="mt-1">
      <Button asChild variant="outline" size="xs">
        <Link href={undoDeepLink(changeSetId)}>
          <Undo2 data-icon="inline-start" />
          Undo last action
        </Link>
      </Button>
    </div>
  );
}
