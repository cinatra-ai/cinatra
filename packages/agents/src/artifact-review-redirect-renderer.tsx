"use client";

// The artifact-review REDIRECT card (cinatra#1796, epic #1620 S13).
//
// When an `input-required` interrupt's gate carries the
// `cinatra.artifactReview.targetsInput` marker, the host has already PINNED the
// run's immutable review targets (`emitArtifactReviewGate`) and emits THIS
// renderer instead of the legacy in-panel reviewer envelope. The card is
// deliberately DISPLAY-ONLY: it links the human to the generic artifact-review
// surface (`/artifacts/review/[runId]/[reviewTaskId]`, the #2014 chrome) where
// the typed approve/reject decision is taken; it NEVER calls `onChange` and
// carries NO approve/continue affordance, so the legacy in-panel approve path
// (which would resume the paused WayFlow run directly) can never double-resume a
// gate whose decision is owned by the review surface + the resume-delivery
// worker.
//
// Registered as a host-internal renderer keyed by strict xRenderer equality on
// ARTIFACT_REVIEW_REDIRECT_RENDERER_ID (register-default-renderers.ts). The id
// does not end in `:output`, so the run panel never classifies it mid-run — no
// auto-emitted Continue row appears beneath it.

import Link from "next/link";
import { ClipboardCheck, ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { FieldRendererProps } from "./field-renderer-registry";

/** The values the execution-time interrupt hook packs for this renderer. */
type ArtifactReviewRedirectValue = {
  reviewSurfaceUrl?: unknown;
  reviewTaskId?: unknown;
  targetCount?: unknown;
  agentSummary?: unknown;
};

function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function ArtifactReviewRedirectRenderer(props: FieldRendererProps) {
  const value = (props.value ?? {}) as ArtifactReviewRedirectValue;
  const reviewUrl = readString(value.reviewSurfaceUrl);
  const agentSummary = readString(value.agentSummary);
  const targetCount =
    typeof value.targetCount === "number" && Number.isFinite(value.targetCount)
      ? value.targetCount
      : null;

  const countLabel =
    targetCount === null
      ? "an artifact this run produced"
      : targetCount === 1
        ? "1 artifact this run produced"
        : `${targetCount} artifacts this run produced`;

  return (
    <div
      data-conformance-id="artifact-review-redirect"
      className="flex flex-col gap-3 rounded-control border border-line bg-surface-strong px-4 py-4"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid size-[30px] flex-none place-items-center rounded-lg bg-mustard-ink/15 text-mustard-ink">
          <ClipboardCheck aria-hidden="true" className="size-4" />
        </span>
        <span className="font-sans text-sm font-bold text-foreground">Review requested</span>
      </div>
      <p className="max-w-[66ch] text-xs leading-relaxed text-muted-foreground">
        This run paused for you to review {countLabel}. Continue on the review surface to
        approve or reject before the run proceeds.
      </p>
      {agentSummary ? (
        <p className="max-w-[66ch] text-xs leading-relaxed text-muted-foreground">
          <span className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
            Agent summary
          </span>{" "}
          {agentSummary}
        </p>
      ) : null}
      {reviewUrl ? (
        <div>
          <Button asChild size="sm" className="gap-1.5" data-action="open-review-surface">
            <Link href={reviewUrl}>
              Continue to review
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          The review surface link is unavailable — refresh the run to retry.
        </p>
      )}
    </div>
  );
}
