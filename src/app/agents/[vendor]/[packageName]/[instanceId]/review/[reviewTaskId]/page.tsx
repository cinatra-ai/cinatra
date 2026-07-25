/**
 * `/artifacts/review/[runId]/[reviewTaskId]` — the generic artifact-review
 * surface (cinatra#1795, epic #1620 S12 item 4). ONE type-agnostic screen on
 * which a human reviews an artifact produced inside an agent run and approves,
 * rejects, or comments on it. Ratified design spec
 * `specs/app-artifact-review.html` @ design@30a0f9c9 (owner-approved) — build
 * EXACTLY to §I–VI, no invented affordances.
 *
 * The surface reads as a review DOCUMENT (§I): a gate header (what is under
 * review + the producing agent's one-line summary when present), then the review
 * target(s) — each an immutable header (§II) + type-resolved renderer with its
 * provenance + the never-blank floor (§III) — then a single decision bar (§IV).
 * The decision is all-or-nothing across the whole gate, permission-gated (§V),
 * and a reject is a tombstone, never a hard delete (§VI).
 *
 * Server component. Host owns dispatch/shell/floor + the decision chrome; the
 * claiming extension ships the type's VIEW (mounted via ReviewTargetMount). The
 * generic surface is display + DECIDE only (epic #1620 ADR) — no type-owned field
 * renderer, no edit affordance, no client-supplied renderer id.
 */
import "server-only";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ClipboardCheck, Lock } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { getAuthSession } from "@/lib/auth-session";

import { loadReviewGateSurface } from "@/app/artifacts/[id]/review-gate-ports";
import type { ReviewDisposition } from "@/lib/artifacts/artifact-review-decision";
import type { ReviewSubmitOutcome } from "@/app/artifacts/review/review-surface-model";

import { resolveReviewActorContext } from "./review-actor";
import { submitReviewDecisionAction } from "./actions";
import { ReviewTargetPanel } from "./review-target-panel";
import { ReviewDecisionBar } from "./review-decision-bar";
import { ReviewGateBlocked, ReviewGateLoading } from "./review-gate-states";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ runId: string; reviewTaskId: string }>;
};

export default async function ArtifactReviewPage({ params }: PageProps) {
  const { runId: rawRunId, reviewTaskId: rawTaskId } = await params;
  const runId = decodeURIComponent(rawRunId);
  const reviewTaskId = decodeURIComponent(rawTaskId);

  const session = await getAuthSession();
  if (!session) redirect("/sign-in");
  const actorCtx = await resolveReviewActorContext();
  if (!actorCtx) redirect("/sign-in");

  const surface = await loadReviewGateSurface({ runId, reviewTaskId, actorCtx });

  if (surface.kind === "not-authorized") {
    return <ReviewNotAuthorizedPanel />;
  }

  if (surface.kind === "blocked") {
    return (
      <ReviewShell>
        <ReviewGateBlocked reason={surface.reason} />
      </ReviewShell>
    );
  }

  // The whole-gate decision action, bound to THIS gate's route params (never a
  // client-supplied gate id). Passed to the client decision bar.
  async function submitAction(input: {
    disposition: ReviewDisposition;
    comment: string | null;
  }): Promise<ReviewSubmitOutcome> {
    "use server";
    return submitReviewDecisionAction(runId, reviewTaskId, input.disposition, input.comment);
  }

  return (
    <ReviewShell>
      {/* §I/§II — the gate header: what is under review + the producing agent's
          one-line summary when present. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="grid size-[30px] flex-none place-items-center rounded-lg bg-mustard-ink/15 text-mustard-ink">
          <ClipboardCheck aria-hidden="true" className="size-4" />
        </span>
        <span className="font-sans text-sm font-bold text-foreground">Review requested</span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-logo/40 bg-logo/15 px-2.5 py-0.5 text-xs font-semibold text-mustard-ink">
          <span className="size-[7px] rounded-full bg-logo" aria-hidden="true" />
          Awaiting your decision
        </span>
      </div>
      {surface.agentSummary ? (
        <p className="max-w-[66ch] text-xs leading-relaxed text-muted-foreground">
          <span className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
            Agent summary
          </span>{" "}
          {surface.agentSummary}
        </p>
      ) : null}

      {/* §II/§III — the review target(s), stacked as sibling panels under one
          decision (the decision is all-or-nothing across the whole gate). */}
      <div className="grid gap-3">
        {surface.targets.map((prepared) => (
          <Suspense
            key={`${prepared.target.artifactId}:${prepared.target.representationRevisionId}`}
            fallback={<ReviewGateLoading />}
          >
            <ReviewTargetPanel prepared={prepared} />
          </Suspense>
        ))}
      </div>

      {/* §IV/§V — the single decision bar governing every target under the gate. */}
      <ReviewDecisionBar permissions={surface.permissions} submitAction={submitAction} />
    </ReviewShell>
  );
}

/** The canonical review-document shell (§I) — inherits the app's single light
 * treatment + the shared shell (Main + PageHeader + PageContent). */
function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Agent run"
        title="Review"
        description="Approve, reject, or comment on what an agent produced — before the run continues."
        divider={false}
      />
      <PageContent className="flex flex-col gap-4 pb-10" data-surface="artifact-review">
        {children}
      </PageContent>
    </Main>
  );
}

/** The standard not-authorized panel (§V) — a viewer with no run access never
 * reaches the targets. */
function ReviewNotAuthorizedPanel() {
  return (
    <Main className="min-h-screen">
      <PageHeader label="Agent run" title="Review" description="Not authorized" divider />
      <PageContent className="flex flex-col gap-6 pb-8">
        <div
          className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-strong px-5 py-14 text-center"
          data-conformance-id="review-not-authorized"
          data-state="error"
        >
          <div className="grid size-10 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
            <Lock aria-hidden="true" className="size-5" />
          </div>
          <p className="text-sm font-semibold text-foreground">
            You don&apos;t have access to this review
          </p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            This review belongs to an agent run you&apos;re not authorized to see.
          </p>
        </div>
      </PageContent>
    </Main>
  );
}
