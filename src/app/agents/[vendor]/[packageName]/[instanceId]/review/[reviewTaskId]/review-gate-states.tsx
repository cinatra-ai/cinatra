"use client";

import { useRouter } from "next/navigation";
import { CircleX } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  reviewBlockedCopy,
  type ReviewBlockedReason,
} from "@/lib/artifacts/review-surface-model";

/**
 * The gate-level BLOCKED state (cinatra#1795 S12 item 4; spec design@5e5c53aff581c01f8b801c4a5e41e9c6f3f0b891 §V):
 * a single blocked panel naming the reason from the closed set, with a REFRESH
 * back to the live gate. It never lets a stale decision through — the gate is no
 * longer the one the reviewer opened. Distinct from a per-target floor (§III),
 * which keeps a target visible; a block stops the whole surface.
 *
 * Conformance anchor: `review-gate-blocked`.
 */
export function ReviewGateBlocked({ reason }: { reason: ReviewBlockedReason }) {
  const router = useRouter();
  const copy = reviewBlockedCopy(reason);
  return (
    <div
      data-conformance-id="review-gate-blocked"
      data-blocked-reason={reason}
      className="rounded-control border border-line bg-surface-strong px-4 py-5 text-center"
    >
      <div className="mx-auto mb-2.5 grid size-9 place-items-center rounded-lg bg-destructive/10 text-destructive">
        <CircleX aria-hidden="true" className="size-[18px]" />
      </div>
      <p className="font-sans text-sm font-semibold text-foreground">{copy.title}</p>
      <p className="mx-auto mt-1 max-w-[46ch] text-xs text-muted-foreground">{copy.body}</p>
      <Button
        variant="link"
        size="sm"
        className="mt-1"
        data-action="refresh-gate -> live-gate"
        onClick={() => router.refresh()}
      >
        Refresh
      </Button>
    </div>
  );
}

/**
 * The gate LOADING skeleton (§V) — shown in each target slot while the host
 * prepares the targets, never a flash of empty chrome.
 *
 * Conformance anchor: `review-gate-loading`.
 */
export function ReviewGateLoading() {
  return (
    <div
      data-conformance-id="review-gate-loading"
      aria-busy="true"
      className="overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      <div className="border-b border-line px-4 py-3">
        <div className="mb-1.5 h-2 w-1/2 rounded bg-surface-muted" />
        <div className="h-1.5 w-2/5 rounded bg-surface-muted" />
      </div>
      <div className="grid gap-2 p-4">
        <div className="h-1.5 w-11/12 rounded bg-surface-muted" />
        <div className="h-1.5 w-4/5 rounded bg-surface-muted" />
        <div className="h-1.5 w-2/3 rounded bg-surface-muted" />
      </div>
    </div>
  );
}
