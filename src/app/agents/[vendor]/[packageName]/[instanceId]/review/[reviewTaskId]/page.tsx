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
 * `specs/app-artifact-review.html` @ design@458fb7ffce6cf4ab6a2c60d3ff47198135d8ea2f (owner-approved) — build
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
import { redirect } from "next/navigation";
import { Lock } from "lucide-react";

import { readAgentRunById, readAgentTemplateById } from "@cinatra-ai/agents/store";
import { buildRunStepperSteps, type RunStepperPolicyStep } from "@cinatra-ai/agents/run-stepper-steps";
import {
  readReviewGate,
  enforceReviewRunAccess,
} from "@cinatra-ai/agents/artifact-review-gate-store";
import { readVerificationRecordForGate } from "@cinatra-ai/agents/lifecycle-verification-store";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { getAuthSession, signInRedirectTarget } from "@/lib/auth-session";

import {
  loadPinnedCapturePair,
  loadReviewGateSurface,
} from "@/app/artifacts/[id]/review-gate-ports";
import type {
  ReviewDisposition,
  SuggestionDecisionPartition,
} from "@/lib/artifacts/artifact-review-decision";
import type { ReviewSubmitOutcome } from "@/lib/artifacts/review-surface-model";

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { ReviewGateCard } from "@cinatra-ai/agents/review-gate-card";
import { RecommendationHoldCard } from "@cinatra-ai/agents/run-recommendation-chip-row";
import { readRunTriggerByRunId } from "@cinatra-ai/agents/trigger-store";
import {
  encodeLifecycleGateRef,
  encodeScheduleRunRef,
} from "@/lib/lifecycle/lifecycle-card-ref";

import { resolveReviewActorContext } from "./review-actor";
import { submitReviewDecisionAction } from "./actions";
import { ReviewGateBlocked } from "./review-gate-states";
import { ReviewRunSteps, type ReviewRunStep } from "./review-run-steps";
import { ScheduleRailStep } from "@cinatra-ai/agents/schedule-rail-step";
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
  const { instanceId: rawInstanceId, reviewTaskId: rawTaskId } = await params;
  // The run instance id IS the review's run id (the review lives under the run).
  const runId = decodeURIComponent(rawInstanceId);
  const reviewTaskId = decodeURIComponent(rawTaskId);
  const sp = (await searchParams) ?? {};
  const isVerificationView = sp.view === "verification";

  const session = await getAuthSession();
  if (!session) redirect(await signInRedirectTarget());
  const actorCtx = await resolveReviewActorContext();
  if (!actorCtx) redirect(await signInRedirectTarget());

  // S4 (cinatra#2042): the run rail's "Audit" entry deep-links here with
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
    // The RECORD is still read here, but only for the page-only adjunct below:
    // the pinned visual pair needs the reviewed target and the record's own
    // out-of-scope paths, and both are server-side store reads. §VII's READING
    // is no longer projected here at all — the card resolves it from its ref
    // against the live reader (cinatra#2789, epic #2784 S9e), which is also
    // where the ADVISORY COMMENTS now travel, so this branch no longer reads
    // them either.
    const record = await readVerificationRecordForGate(gate.id);
    // S6 (#2044 L-D): the field diff's VISUAL counterpart — the reviewed proposal
    // beside the page as it actually landed, with the read-back's own
    // out-of-scope paths outlined on the applied side. A pure store read of the
    // captures pinned against the record's REVIEWED target; nothing is fetched
    // from the site here either. Absent for a non-CMS target (renders nothing).
    const visualPair = record
      ? loadPinnedCapturePair(
          actorCtx.orgId,
          record.reviewedTarget,
          "verification",
          record.fieldDiff
            .filter((f) => !record.scopeManifest.paths.includes(f.field))
            .map((f) => f.field),
        )
      : null;
    // The audit card's ref — the SAME gate-scoped ticket the run card and a chat
    // transcript address the card with (both kinds hang off the gate, so both
    // share one codec). Minted per request here because the page reaches the
    // gate by route params and has no envelope to read.
    const verificationCardRef = encodeLifecycleGateRef({ runId, reviewTaskId });
    return (
      <ReviewShell>
        {record ? (
          <VerificationView cardRef={verificationCardRef} visualPair={visualPair} />
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

  // The generic blocked panel is still the page's answer for a gate it cannot
  // show: `targets-mismatch` (a stale or tampered view) and the `unavailable`
  // gate the loader keeps here — a ref that names nothing, or a row too corrupt
  // to read. Neither is a decided review, so neither becomes card DOM
  // (cinatra#2904, AC 4 + AC 5).
  if (surface.kind === "blocked") {
    return (
      <ReviewShell>
        <ReviewGateBlocked reason={surface.reason} />
      </ReviewShell>
    );
  }

  // A DECIDED gate falls through to the SAME composition a pending one draws
  // (cinatra#2904). The page short-circuited here before, so the one renderer
  // was never mounted on `page_gate_region` and the review page contradicted the
  // transcript about the same gate at the same moment — plan §4.4 step 7,
  // "Everyone looking at that run, in any channel, sees the same settled card."
  // Nothing below is settled-specific: the card resolves its own state from the
  // ref against the live reader, so it draws the recorded outcome and its
  // decider where the state is `settled` with one, and falls back to the generic
  // blocked reading with its Refresh where the disposition cannot be read
  // (`review-gate-card.tsx`). The ONE thing the page withholds from a settled
  // gate is the prompt window at the foot — see below.

  const { steps, activeStep, templateId } = await loadRunStepsContext(runId);

  // The whole-gate decision action, bound to THIS gate's route params (never a
  // client-supplied gate id). Passed to the client decision bar AND the prompt
  // window (both route through the same server helper; the prompt window is the
  // Comment path — the changes-request channel — not a fourth decision).
  async function submitAction(input: {
    disposition: ReviewDisposition;
    comment: string | null;
    suggestionDecisions?: SuggestionDecisionPartition | null;
  }): Promise<ReviewSubmitOutcome> {
    "use server";
    // The per-item SUGGESTION partition (cinatra#2572, epic #2564 S6c) rides the
    // page's decision exactly as it rides the card's: as the last argument of the
    // ONE decision helper, which normalizes it, refuses it on a non-terminal
    // disposition, checks it `⊆` the gate's pinned snapshot BEFORE the CAS and
    // folds it into the fingerprint. It is CLIENT INPUT and is treated as such —
    // nothing here trusts its shape; `normalizeSuggestionPartition` inside the
    // core is the one validator, and it bounds both list length and id length
    // before any store is touched. Passing it through here rather than minting a
    // page-local per-item action is what keeps the page and the card on ONE
    // decision path (#2047 row 8).
    return submitReviewDecisionAction(
      runId,
      reviewTaskId,
      input.disposition,
      input.comment,
      undefined,
      input.suggestionDecisions ?? null,
    );
  }

  // The gate's card ref — the same authenticated-encrypted ticket the run card
  // and a chat transcript address the card with. Minted per request here (rather
  // than read off the gate) because the page reaches the gate by route params and
  // has no envelope to read.
  const gateCardRef = encodeLifecycleGateRef({ runId, reviewTaskId });

  // §VI's card as THE SCHEDULE STEP IN THE RAIL (cinatra#2788, epic #2784 S9d).
  //
  // NEVER BESIDE THE REVIEW CARD. Plan (A) §7.2 step 5: "On the run page and the
  // review page the schedule is a **dedicated step in the step rail on the left,
  // above '1 Review'**: open that step to see the configuration or change it —
  // it opens to the right of the steps, never directly under a step … The
  // schedule is never drawn as a card among the review cards — a trigger decides
  // *when* the agent runs, and a review card exists only after the agent has run
  // and produced something — so the two can never appear together." So the step
  // heads the rail and its configuration opens in the region on the RIGHT, in
  // place of the review card, which is how the two can never be drawn together.
  // The page opens on the review card: the reviewer came here to decide it.
  //
  // THE REF IS THE RUN'S. This page reaches its subject by route params and
  // holds no turn, so the card is addressed by a run-scoped ref minted here,
  // whose resolver re-derives the proposal's (viewer, organization, template)
  // binding from its own consume row.
  //
  // THE STEP IS DRAWN ONLY FOR A RUN THAT HAS A SCHEDULE. A run with no trigger
  // row has nothing for the step to open onto, and the card would resolve
  // `absent` and draw no DOM — so the rail shows no schedule step at all rather
  // than an empty one. Presence of the row is all this read decides; WHAT the
  // step may show is still re-resolved against the live reader on the endpoint,
  // which answers `absent` for a run this reader did not confirm a proposal for.
  const scheduleCardRef = (await readRunTriggerByRunId(runId).catch(() => null))
    ? encodeScheduleRunRef({ runId })
    : null;

  return (
    <ReviewShell>
      <div className="flex items-start gap-6" data-run-detail-contract="">
        {(() => {
          // The agent run STEPS on the left, as run context (cinatra#2063).
          const railNode = (
            <ReviewRunSteps steps={steps} activeStep={activeStep} scheduleCardRef={scheduleCardRef} />
          );
          /* The gate REGION on the right (cinatra#2566, epic #2564 S2). The page's
          own composition — gate header, the stacked target panels, the decision
          bar — is GONE from here and lives in `ReviewGateCard`, the one renderer
          the chat thread and the run card mount too. The page keeps its deeper
          chrome (the run step rail beside it, the prompt window below, the
          verification view) and supplies two things the card cannot derive: the
          server-minted ref that addresses this gate, and the ROUTE-BOUND decision
          action it has always used, so the page's decision transport is exactly
          what it was before the move.
          
          When the ref cannot be minted (no instance auth secret), the page falls
          back to nothing rather than to a second composition — there is only one
          drawing of a review, and an instance that cannot mint refs is a
          configuration fault to fix, not a reason to fork the surface. */
          const detailNode = (
            <LifecycleCardSurfaceProvider host="page_gate_region">
              {/* THE RUN-START SKILLS QUESTION, at its plan-designated position
                  (cinatra#2790, epic #2784 S9f; plan §6.4 "the same row appears on
                  the run page, ahead of the steps it would authorize, and on the
                  review page, where it is mostly seen in its decided form", and §9
                  "review page — keyed by the run").

                  ABOVE the gate card, and that ordering is the design's, not a
                  layout choice: the recommendation is the decision taken BEFORE
                  the run produced anything, and the review is the decision taken
                  after. Reading down the gate region is reading the run in order.

                  ONE RENDERER, NO FORK. This is the same `RecommendationHoldCard`
                  the run panel and the widget mount — the card owns whether it
                  draws, which state it is in, and when it re-reads — so it is
                  keyed by the run and nothing else, and it renders NOTHING when
                  the run never held or the reader may not see it. On this page
                  that is usually its settled reading, which is exactly what §9
                  says is mostly seen here. The host declaration is the one on the
                  root of this region: a card is a `page_gate_region` mount because
                  THIS provider says so, per the anchor contract. */}
              <RecommendationHoldCard runId={runId} />
              {gateCardRef ? (
                <ReviewGateCard
                  view={{
                    viewType: "artifact_review_gate",
                    schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
                    ref: gateCardRef,
                  }}
                  submitAction={submitAction}
                />
              ) : null}
            </LifecycleCardSurfaceProvider>
          );
          if (scheduleCardRef) {
            return (
              <ScheduleRailStep
                host="page_gate_region"
                cardRef={scheduleCardRef}
                displayStep={1}
                rail={railNode}
                detail={detailNode}
                initialSelection="detail"
              />
            );
          }
          return (
            <>
              {railNode}
              <div className="flex min-w-0 flex-1 flex-col gap-4">{detailNode}</div>
            </>
          );
        })()}
      </div>

      {/* owner ruling (1) — the REAL conversational prompt window (the
          changes-request channel). Sticky, portalled into <main>; mounted only when
          the reviewer may Comment (respond access) on a gate that is still OPEN.
          A settled gate carries no comment channel and no permission answer to
          read one from: the loader resolves the decision axis for a pending gate
          only, and the card's own settled branch draws no floor either, so the
          foot of the page agrees with the card above it. */}
      {surface.kind === "ready" ? (
        <ReviewPromptWindow
          submitAction={submitAction}
          canComment={surface.permissions.canComment}
          runId={runId}
          boundCardRef={gateCardRef}
          storageKey={`cinatra_review_prompt_${templateId ?? "run"}_${reviewTaskId}`}
        />
      ) : null}
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
