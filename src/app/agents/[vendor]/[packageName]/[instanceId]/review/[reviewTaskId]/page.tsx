/**
 * `/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]` — the
 * generic artifact-review surface, now mounted UNDER the agent run (owner ruling
 * 2026-07-25, cinatra#2063): the review is part of an agent run, `instanceId` is
 * the run id, and the surface reads as run context — the agent run STEPS on the
 * LEFT (ruling (2)) and the gate/target detail + decision on the RIGHT, with the
 * REAL conversational prompt window (ruling (1)) as the changes-request channel.
 * Superseded route: the standalone `/artifacts/review/[runId]/[reviewTaskId]`
 * (cinatra#1795) is retired — no redirect (ruling (3)).
 *
 * ONE type-agnostic screen on which a human reviews an artifact produced inside an
 * agent run and approves, rejects, or comments on it. Ratified design spec
 * `specs/app-artifact-review.html` @ design@5e5c53aff581c01f8b801c4a5e41e9c6f3f0b891 (owner-approved) — build
 * EXACTLY to §I–VI, no invented affordances.
 *
 * The surface reads as a review DOCUMENT (§I): a gate header (what is under
 * review + the producing agent's one-line summary when present), then the review
 * target(s) — each an immutable header (§II) + type-resolved renderer with its
 * provenance + the never-blank floor (§III) — then a single decision bar (§IV).
 * The decision is all-or-nothing across the whole gate, permission-gated (§V),
 * and a reject is a tombstone, never a hard delete (§VI). The decision floor is
 * exactly Approve/Reject/Comment; the prompt window is not a fourth button.
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

import { readAgentRunById, readAgentTemplateById } from "@cinatra-ai/agents/store";
import { buildRunStepperSteps, type RunStepperPolicyStep } from "@cinatra-ai/agents/run-stepper-steps";
import {
  readReviewGate,
  readAdvisoryCommentsForGates,
  enforceReviewRunAccess,
} from "@cinatra-ai/agents/artifact-review-gate-store";
import { readVerificationRecordForGate } from "@cinatra-ai/agents/lifecycle-verification-store";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { getAuthSession } from "@/lib/auth-session";

import { loadReviewGateSurface } from "@/app/artifacts/[id]/review-gate-ports";
import type { ReviewDisposition } from "@/lib/artifacts/artifact-review-decision";
import {
  pinnedCaptureKey,
  type ReviewSubmitOutcome,
} from "@/lib/artifacts/review-surface-model";

import { resolveReviewActorContext } from "./review-actor";
import { submitReviewDecisionAction } from "./actions";
import { ReviewTargetPanel } from "./review-target-panel";
import { ReviewDecisionBar } from "./review-decision-bar";
import { ReviewGateBlocked, ReviewGateLoading } from "./review-gate-states";
import { ReviewRunSteps, type ReviewRunStep } from "./review-run-steps";
import { ReviewPromptWindow } from "./review-prompt-window";
import { VerificationView } from "./verification-view";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{
    vendor: string;
    packageName: string;
    instanceId: string;
    reviewTaskId: string;
  }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * The agent-run STEP list for the left column (owner ruling (2)). Loads the run's
 * producing-agent steps as pure context — no actor is passed to
 * `readAgentRunById` (the worker/deep-link pattern): the reviewer already cleared
 * the review READ gate inside `loadReviewGateSurface`, and only benign step
 * LABELS are read here, never run data. Any missing link (orphan run, absent
 * template) yields an empty list, and the surface still shows the active Review
 * step. A synthetic "Review" step is appended as the ACTIVE (gated) step so the
 * left column always communicates "you are at this run's review".
 */
async function loadRunStepsContext(
  runId: string,
): Promise<{ steps: ReviewRunStep[]; activeStep: number; templateId: string | null }> {
  let runSteps: ReviewRunStep[] = [];
  let templateId: string | null = null;
  try {
    const run = await readAgentRunById(runId);
    if (run) {
      templateId = run.templateId ?? null;
      const template = run.templateId ? await readAgentTemplateById(run.templateId) : null;
      const policySteps = (template?.approvalPolicy?.steps ?? []) as ReadonlyArray<RunStepperPolicyStep>;
      runSteps = buildRunStepperSteps(policySteps).map((s) => ({ index: s.index, label: s.label }));
    }
  } catch {
    runSteps = [];
  }
  const reviewIndex = runSteps.length + 1;
  const steps: ReviewRunStep[] = [...runSteps, { index: reviewIndex, label: "Review" }];
  return { steps, activeStep: reviewIndex, templateId };
}

export default async function AgentRunReviewPage({ params, searchParams }: PageProps) {
  const { vendor, packageName, instanceId: rawInstanceId, reviewTaskId: rawTaskId } = await params;
  // The run instance id IS the review's run id (the review lives under the run).
  const runId = decodeURIComponent(rawInstanceId);
  const reviewTaskId = decodeURIComponent(rawTaskId);
  const sp = (await searchParams) ?? {};
  const isVerificationView = sp.view === "verification";

  const session = await getAuthSession();
  if (!session) redirect("/sign-in");
  const actorCtx = await resolveReviewActorContext();
  if (!actorCtx) redirect("/sign-in");

  // S4 (cinatra#2042): the run rail's "Core analysis" entry deep-links here with
  // `?view=verification` — the before/after field diff of a repaired revision. It
  // is READ-ONLY and works for a resolved gate (unlike the pending-gate decision
  // surface), so it enforces run READ access directly rather than through the
  // pending-gate surface loader.
  if (isVerificationView) {
    const access = await enforceReviewRunAccess(runId, actorCtx.actor, "read", actorCtx.roleHints);
    if (!access.ok) return <ReviewNotAuthorizedPanel />;
    const gate = await readReviewGate(runId, reviewTaskId);
    if (!gate) {
      return (
        <ReviewShell>
          <ReviewGateBlocked reason="no-longer-pending" />
        </ReviewShell>
      );
    }
    const [record, advisory] = await Promise.all([
      readVerificationRecordForGate(gate.id),
      readAdvisoryCommentsForGates([gate.id]),
    ]);
    const backHref = `/agents/${vendor}/${packageName}/${encodeURIComponent(runId)}/review/${encodeURIComponent(reviewTaskId)}`;
    return (
      <ReviewShell>
        {record ? (
          <VerificationView
            outcome={record.outcome}
            reviewedRevisionId={record.reviewedTarget.representationRevisionId}
            repairedRevisionId={record.repairedTarget.representationRevisionId}
            fieldDiff={record.fieldDiff}
            scopePaths={record.scopeManifest.paths}
            advisoryComments={advisory.map((c) => ({ id: c.id, authorKind: c.authorKind, body: c.body }))}
            gateHref={backHref}
          />
        ) : (
          <ReviewGateBlocked reason="no-longer-pending" />
        )}
      </ReviewShell>
    );
  }

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

  const { steps, activeStep, templateId } = await loadRunStepsContext(runId);

  // The whole-gate decision action, bound to THIS gate's route params (never a
  // client-supplied gate id). Passed to the client decision bar AND the prompt
  // window (both route through the same server helper; the prompt window is the
  // Comment path — the changes-request channel — not a fourth decision).
  async function submitAction(input: {
    disposition: ReviewDisposition;
    comment: string | null;
  }): Promise<ReviewSubmitOutcome> {
    "use server";
    return submitReviewDecisionAction(runId, reviewTaskId, input.disposition, input.comment);
  }

  return (
    <ReviewShell>
      <div className="flex items-start gap-6">
        {/* owner ruling (2) — the agent run STEPS on the left as run context. */}
        <ReviewRunSteps steps={steps} activeStep={activeStep} />

        {/* The gate/target detail + decision on the right. */}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
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
                <ReviewTargetPanel
                  prepared={prepared}
                  pinnedCaptures={surface.pinnedCaptures[pinnedCaptureKey(prepared.target)] ?? []}
                />
              </Suspense>
            ))}
          </div>

          {/* §IV/§V — the single decision bar governing every target under the gate. */}
          <ReviewDecisionBar permissions={surface.permissions} submitAction={submitAction} />
        </div>
      </div>

      {/* owner ruling (1) — the REAL conversational prompt window (the
          changes-request channel). Sticky, portalled into <main>; mounted only when
          the reviewer may Comment (respond access). */}
      <ReviewPromptWindow
        submitAction={submitAction}
        canComment={surface.permissions.canComment}
        storageKey={`cinatra_review_prompt_${templateId ?? "run"}_${reviewTaskId}`}
      />
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
