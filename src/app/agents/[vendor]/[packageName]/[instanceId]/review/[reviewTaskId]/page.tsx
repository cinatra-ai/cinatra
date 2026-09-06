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
 * `specs/app-artifact-review.html` @ design@0c484154b069c6369a33c1375056126289888997 (owner-approved) — build
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
import { PageHeaderTitleSync } from "@/components/page-header-title-sync";
import { getAuthSession, signInRedirectTarget } from "@/lib/auth-session";

import {
  loadPinnedCapturePair,
  loadReviewGateSurface,
} from "@/app/artifacts/[id]/review-gate-ports";
import { firstPartyReviewSurfaceRoads } from "@/app/artifacts/[id]/review-surface-roads";
import type {
  ReviewDisposition,
  SuggestionDecisionPartition,
} from "@/lib/artifacts/artifact-review-decision";
import type { ReviewSubmitOutcome } from "@/lib/artifacts/review-surface-model";

import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "@cinatra-ai/agent-ui-protocol/renderable-views";
import { LifecycleCardSurfaceProvider } from "@cinatra-ai/agents/lifecycle-card-runtime";
import { ReviewGateCard } from "@cinatra-ai/agents/review-gate-card";
import { AgentHitlScreenCard } from "@cinatra-ai/agents/agent-hitl-screen-card";
import { readRunTriggerByRunId } from "@cinatra-ai/agents/trigger-store";
import { readRecommendationParkForRun } from "@cinatra-ai/agents/recommendation-hold";
import { recommendationDecidedForRun } from "@cinatra-ai/agents/run-recommendation-core";
import {
  recommendationRailEntry,
  recommendationRailStepOpens,
} from "@cinatra-ai/agents/recommendation-rail-entry";
import {
  encodeLifecycleGateRef,
  encodeScheduleRunRef,
} from "@/lib/lifecycle/lifecycle-card-ref";

import { resolveReviewActorContext } from "./review-actor";
import { submitReviewDecisionAction } from "./actions";
import { ReviewGateBlocked } from "./review-gate-states";
import { ReviewRunSteps, type ReviewRunStep } from "./review-run-steps";
import { ReviewRunSurface } from "./review-run-surface";
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
      // The run's own record of each step, as the run page hands it over
      // (cinatra#3226): the two surfaces project ONE list, so a step the run
      // page names by its work is named the same here.
      runSteps = buildRunStepperSteps(policySteps, { stepResults: run.stepResults ?? null }).map((s) => ({
        index: s.index,
        label: s.label,
      }));
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

  const surface = await loadReviewGateSurface({
    runId,
    reviewTaskId,
    actorCtx,
    // WAVE 3 of `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091): the
    // content channel, so "the json, cms-snapshot and text displays draw
    // through the content channel on EVERY host" — this one included. The byte
    // road stays the session routes here: they work under a cookie and they are
    // the narrower grant.
    roads: firstPartyReviewSurfaceRoads(),
  });

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

  // §V's card AS THE SKILLS STEP IN THE RAIL (cinatra#3047, the re-shoot's
  // first and second defects).
  //
  // NEVER ABOVE THE REVIEW CARD. The change request: "Every HITL shows on its
  // own dedicated page. Do not show skills on top of a HITL card. Do not show
  // the skills on top of the review card or the schedule card or any other card
  // either." The ratified drawing at the capture contract's pin puts it as one
  // page per gate, and draws this page's own rail with the Skills entry first,
  // settled, above the run's steps. The card was mounted straight into the gate
  // region here — above the review card, in the reading point C retired — while
  // the rail carried no Skills entry at all, and this route is a second
  // composition of the run surface that the run page's own fix never reached.
  //
  // THE PARK ROW IS THE WHOLE READING, and it is the SAME read the run page and
  // the setup run page make (`recommendation-rail-entry.ts`): a run that never
  // held has no entry at all, a live hold is the step the run is paused on, a
  // decided one is the rail's read-only history row, and a park the TTL sweeper
  // left terminal-but-unanswered opens onto nothing and so is closed and muted.
  // Nothing is prefetched, no candidates are resolved and no decision state is
  // derived here — the card owns the interaction (cinatra#2573); this asks only
  // whether the question was ever asked. It is a plain run-scoped read behind
  // the access door `loadReviewGateSurface` cleared above.
  const recommendationPark = await readRecommendationParkForRun(runId).catch(() => null);
  const recommendationEntry = recommendationRailEntry({
    hasPark: recommendationPark !== null,
    held: recommendationPark?.status === "parked",
  });
  const recommendationStepOpens = recommendationRailStepOpens({
    entry: recommendationEntry,
    parkStatus: recommendationPark?.status,
    // A DECISION THAT RACED THE TTL SWEEPER IS STILL A DECISION (cinatra#3047,
    // convergence). The park's status and the decision's evidence are not
    // written atomically, so a confirm or a skip that lands as the sweeper fires
    // leaves `policy_unresolved` behind with the answer on file — and the card
    // draws that run's settled row. Reading the status alone would leave this
    // page's Skills row settled on the rail and closed, with the run's own
    // answer reachable nowhere, while the run page opens the same card. One
    // definition of "decided" (`recommendationDecidedForRun`), asked by both.
    decided: recommendationDecidedForRun({
      runId,
      parkStatus: recommendationPark?.status,
    }),
  });

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
              {/* THE GATE REGION CARRIES THE REVIEW CARD AND THE RUN'S OWN
                  PARKED QUESTION — AND NOT THE SKILLS ROW (cinatra#3047, the
                  re-shoot's first defect).

                  §V's card stood HERE, above the gate card, and the ordering was
                  argued as the design's: "the recommendation is the decision
                  taken BEFORE the run produced anything, and the review is the
                  decision taken after". The drawing at the capture contract's
                  pin has since ruled the other way and the change request says
                  so in its own words — one page per gate, and "do not show the
                  skills on top of the review card". So the Skills question is a
                  STEP on this page's rail now, and its row opens in the run
                  detail in place of what is here, never stacked over it. The
                  mount moved to `review-run-surface.tsx`; the HOST did not. */}
              {/* THE QUESTION THE RUN IS PARKED ON, on the same host and by the
                  same rule (cinatra#2930, lifecycle-b W3). Section IX's "every
                  card appears on every host" is the epic's structural thesis,
                  and this region is the fourth host: the card is keyed by the
                  run and nothing else, and it owns whether it draws. A run that
                  is not parked asking a question renders NOTHING here, which on
                  this page is the usual reading — a review and a mid-flight
                  question are different moments of the same run. What the mount
                  buys is that a reviewer who arrives while the run IS waiting
                  sees the question rather than a page that looks stalled. */}
              <AgentHitlScreenCard runId={runId} />
              {gateCardRef ? (
                <ReviewGateCard
                  view={{
                    viewType: "artifact_review_gate",
                    schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
                    ref: gateCardRef,
                  }}
                  submitAction={submitAction}
                  // §VI — the gate's own conversational prompt window keeps its
                  // exchange with the RUN (cinatra#3141 item 1); the card draws
                  // the window now, so the page names the run and mounts none.
                  runId={runId}
                />
              ) : null}
            </LifecycleCardSurfaceProvider>
          );
          // THE TWO COLUMNS, AND THE GATE STEPS THAT HEAD THEM. Which steps
          // this run has, which numeral each carries and which of them can be
          // opened are the rail's own rules rather than this page's — see
          // `review-run-surface.tsx`, which is the one place they are applied
          // for this route.
          return (
            <ReviewRunSurface
              runId={runId}
              recommendationEntry={recommendationEntry}
              recommendationStepOpens={recommendationStepOpens}
              scheduleCardRef={scheduleCardRef}
              rail={railNode}
              detail={detailNode}
            />
          );
        })()}
      </div>

      {/* §VI's conversational prompt window IS THE GATE'S, and the gate is the
          card (cinatra#3141 item 1). It used to be mounted here, at page level
          and outside the card — which is why the run page's own review gate
          carried no window at all while this page carried one. The drawing puts
          it inside the gate's frame, beneath the decision bar, so `ReviewGateCard`
          draws it on every surface the gate opens on and this page mounts none:
          one card per gate is one window per gate, and the review page cannot
          draw a second. */}
    </ReviewShell>
  );
}

/**
 * The review shell — the app's single light treatment and the shared shell
 * (Main + PageContent), and NO page-title block.
 *
 * THE GATE IS THE WHOLE SURFACE. §III of the ratified artifact-review drawing:
 * "the gate itself — header, the one review target, decision bar and the run's
 * prompt window — fills the run detail on the right. There is no standalone
 * review document." The shell used to open with an eyebrow ("Agent run"), a page
 * heading ("Review") and a subtitle above the gate; the drawing gives the run
 * detail none of the three, and the graded proof frames measured all three. The gate's
 * own header — "Review requested" over the awaiting-your-decision pill — is the
 * heading this surface has, and the card draws it on every host.
 *
 * The not-authorized panel below keeps its own header: that reading is not the
 * gate at all (§VII), and a refusal with no title names nothing.
 *
 * WHAT THE BLOCK CARRIED THAT IS NOT PIXELS STAYS. The drawing fixes what is
 * DRAWN; it does not ask this route to stop naming itself to a screen reader or
 * to the breadcrumb. The page-title block was also the surface's only `h1` and
 * the only thing broadcasting a leaf-crumb title, so removing it outright left
 * the reading with no heading at all and left the breadcrumb humanising the raw
 * review-task id (`buildBreadcrumbTrail` falls through to `idSegmentPlaceholder`
 * with no page title on the bus). Both are kept here with zero drawn pixels: an
 * `sr-only` heading and the same title broadcast the removed header mounted.
 */
function ReviewShell({ children }: { children: React.ReactNode }) {
  return (
    <Main className="min-h-screen">
      <h1 className="sr-only">Review</h1>
      <PageHeaderTitleSync title="Review" />
      <PageContent className="flex flex-col gap-4 pt-6 pb-10" data-surface="artifact-review">
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
