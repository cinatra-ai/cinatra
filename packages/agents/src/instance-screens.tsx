import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { inArray } from "drizzle-orm";
import { Main } from "@/components/layout/main";
import {
  getAuthSession,
  isPlatformAdmin,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthUsers,
  readOrgsWithTeamsForUserActiveOnly,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import { readAgentTemplateBySlug, readAgentRunById, readAgentRunMessages, readAgentTemplates, ensureRunTitle, readRunCoOwners } from "./store";
import { randomUUID } from "node:crypto";
import { resolveEffectivePolicy, buildScopeReason, resolveTemplateVisibilityActor } from "./auth-policy";
import type { ActorRoleHints } from "./auth-policy";
import { buildRunStepperSteps, type RunStepperPolicyStep } from "./run-stepper-steps";
import {
  listReviewGatesForRun,
  readReviewGate,
  readRunReviewSlot,
  readVerificationRecordsForGates,
} from "./artifact-review-gate-store";
import { readLifecycleDecisionsForRun } from "./lifecycle-policy-store";
import { buildRunStepRail, type RailMessage } from "./run-step-rail";
import { RunStepRailPanel } from "./run-step-rail-panel";
import { readRecommendationParkForRun } from "./recommendation-hold";
import { deriveRunHitlContext } from "./hitl-context";
import { PRE_EXECUTION_RUN_STATUSES } from "./run-status";
// The step from the run's review slot to what the review step draws
// (cinatra#2970). A leaf, so this server component can call it.
import { runReviewStepReading, runReviewStepSettled } from "./run-review-slot-reading";
import { RecommendationHoldCard } from "./run-recommendation-chip-row";
import { LifecycleCardSurfaceProvider } from "./lifecycle-card-runtime";
// §VII's card on the `run_card` host (cinatra#2789, epic #2784 S9e) — see the
// mount below for what it draws and what it deliberately does not.
import { VerificationSummaryCard } from "./verification-summary-card";
// §IV's review card, and the placeholder it replaces — the two components the
// run page's panel draws the run's review slot with (cinatra#2997). The setup
// run page's review step draws the same slot with the same two, so the review a
// run owes reads the same on both screens (cinatra#2970).
import { LIFECYCLE_VIEW_SCHEMA_VERSION, ReviewGateCard } from "./review-gate-card";
import { ReviewGatePlaceholder } from "./review-gate-states";
// One import for both card refs: §VII's audit card is addressed by its GATE and
// §VI's schedule card by its RUN, and the two codecs live in one module.
import {
  encodeLifecycleGateRef,
  encodeScheduleRunRef,
} from "@/lib/lifecycle/lifecycle-card-ref";
import { AuthzError } from "@/lib/authz";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
// agent_run mounts the generic ExtensionPermissionsClient.
// Type re-exports (AvailableScopes, CoOwnerView) originate from their
// canonical sources to keep this file decoupled from the
// permissions-tab-client.tsx wrapper.
import { ExtensionPermissionsClient } from "@/components/extension-permissions-client";
import type { OwnerView as CoOwnerView } from "@/components/permissions-form";
import type { AvailableScopes } from "@/components/access-combobox";
import { removeRunOwner } from "./run-sharing-actions";
import { RunAgentButton } from "./run-dialog";
import { createAndTriggerRunWithContext, buildSubmissionMapByStepIndex, type SubmissionMapEntries } from "./run-actions";
import { SetupCompletionWatcher } from "./setup-completion-watcher";
// cinatra#2933 (lifecycle-b W5b) — who may TYPE in a run's prompt window is the
// run's own access, resolved on the server so no window is drawn for a person
// whose message it would refuse.
import { canRespondInRunWindow } from "@/lib/lifecycle/run-window-turn";
import { TriggerStepWatcher } from "./trigger-step-watcher";
import { type SerializedAgentRunMessage } from "./agentic-run-panel";
import { AgentPageLayout, AgentPanelBody } from "./agent-page-layout";
import { OrchestratorStepperPanel } from "./orchestrator-stepper-panel";
import { TriggerScreenClient } from "./trigger-screen-client";
import { estimateRunDuration } from "./trigger-duration-estimate";
// §VI's card on the `run_card` host (cinatra#2788, epic #2784 S9d), reached
// through the run page's SCHEDULE STEP and — since cinatra#3004 — through the
// run's own schedule tab. Two adapters, one renderer; see the mounts below.
import { ScheduleRailStepRow, ScheduleStepSurface } from "./schedule-rail-step";
import { RunScheduleTab } from "./run-schedule-tab";
// §V's card at its plan-designated rail position (cinatra#2790, epic #2784 S9f):
// the recommendation is the run's FIRST step, and it answers the SAME question
// the setup run page's recommendation row asks (cinatra#2970) — one predicate,
// read by both screens.
import {
  recommendationRailEntry,
  recommendationRailStepOpens,
} from "./recommendation-rail-entry";
import { RecommendationRailStepRow } from "./recommendation-rail-step";
// The two columns of the run surface — the step rail on the left, the selected
// step's own surface on the right. The run page composes the frame around its
// own rail rows and run detail; the setup run page composes the whole frame from
// it, with the shared row for steps that carry no anchors of their own
// (cinatra#2970).
import { RunSurfaceRail } from "./run-surface-rail";
// The step's own shape, and the setup page's step-to-row mapping. Both read from
// modules with NO "use client" directive, never from the client one: this screen
// is a server component and it EVALUATES them, which a client reference cannot
// answer (`instance-screens-client-boundary.test.ts`).
import type {
  RunInputStepKey,
  RunStepSelection,
  RunSurfaceRailStep,
} from "./run-surface-rail-step";
import { buildSetupRailSteps, type SetupRailStep } from "./setup-run-surface-steps";
// The labels come from a module with NO "use client" directive, deliberately:
// this screen is a server component, and a constant imported from the rail's own
// client module reaches it as a client reference whose `.schedule` reads
// `undefined` rather than the label (cinatra#2970).
import { RUN_SURFACE_RAIL_LABELS } from "./run-surface-rail-labels";
import { buildRunInputRailSteps } from "./run-input-rail-steps";
import {
  buildRunInputSteps,
  openRunInputStepKey,
  runAtInputMoment,
  runCarriesInputSteps,
} from "./run-input-steps";
// THE SCHEMA THE SETUP LOOP ACTUALLY ASKS FROM (cinatra#3068 convergence). A
// stored `input_schema: {}` is resolved from the installed agent's OAS at
// execution time, so a screen reading the stored one alone would name no input
// step for exactly the agents whose form is nevertheless asked.
import { resolveTemplateInputSchema } from "./input-schema-resolver";
import { readRunTriggerByRunId } from "./trigger-store";
// Did a confirmed conversation proposal create this run? The one fact the
// schedule-step picker below cannot read off the trigger row itself.
import { readProposalConsumeByRunId } from "./trigger-schedule-proposal-store";

// ---------------------------------------------------------------------------
// Schedule tab visibility helper.
//
// Visibility rule:
//   - agent_run_triggers row exists AND triggerType IN ('scheduled','recurring')
//     → show the persistent Schedule tab, which since cinatra#3004 IS the
//       schedule form (`RunScheduleTab` → `ScheduleProposalCard`)
//   - otherwise → show the first-step form (TriggerScreenClient)
//
// Exported so the unit test can lock the rule independently of DB / auth.
// ---------------------------------------------------------------------------
/**
 * IS A PERSON PRESENT FOR THIS RUN, as the schedule moment asks it
 * (cinatra#2936)?
 *
 * One of the two inputs the runner's schedule default takes, read off the run
 * row. `humanPresent` is `boolean | null`: it records whether the run was
 * STARTED by a person (cinatra#2067) and every producer that does not stamp it
 * leaves it unset, so `null` records NOTHING rather than recording absence. A
 * run only reaches the scheduling step by coming back from someone answering its
 * setup gate, so an unrecorded stamp reads as the person standing at the screen;
 * a row that records `false` is taken at its word and the step draws no
 * selection for it.
 *
 * Exported so the unit test can lock the rule independently of DB / auth.
 */
export function schedulePresenceForRun(
  run: { humanPresent?: boolean | null } | null | undefined,
): boolean {
  return run?.humanPresent !== false;
}

export function shouldShowPersistentTab(
  trigger: { triggerType: string } | null,
): boolean {
  return (
    !!trigger &&
    (trigger.triggerType === "scheduled" || trigger.triggerType === "recurring")
  );
}

/**
 * WHICH of the two `run_card` schedule adapters a screen draws (cinatra#3004).
 *
 * One renderer, two adapters: the run detail opens the schedule as a step in its
 * rail (`ScheduleStepSurface`), and the run's own schedule tab is the form on
 * its own (`RunScheduleTab`). They are exclusive because they are different
 * ROUTES — one run is never both screens at once — and this is the picker that
 * says so in code rather than leaving it to be inferred from two mounts in one
 * file.
 *
 * `"none"` where there is nothing to draw, and that is the WHOLE reading on both
 * screens: a step or a tab that opens onto an empty column is the defect this
 * answers. A run with no trigger row has no schedule for either adapter to open
 * onto; a row of a kind the card resolver refuses draws nothing either, so no
 * step is offered for it. The two SCHEDULED kinds are named — the same
 * allow-list `shouldShowPersistentTab` and the resolver read — so a kind added
 * later is absent by default rather than drawn as an empty step.
 *
 * `fromProposal` is the one widening, and only on the RUN DETAIL: a run created
 * by confirming a schedule stated in a conversation keeps drawing whatever it
 * settled into, `immediate` included, because that card has always been the
 * answer to a schedule the reader stated and the resolver still draws it. The
 * TAB is not widened by it — a proposal in a conversation is not what puts a
 * schedule tab on a run's page, and `shouldShowPersistentTab` has always been
 * the whole rule there.
 */
export type RunScheduleAdapter = "rail_step" | "schedule_tab" | "none";

export function runScheduleAdapterFor(input: {
  screen: "run_detail" | "schedule_tab";
  trigger: { triggerType: string } | null;
  /** Did a confirmed conversation proposal create this run? */
  fromProposal?: boolean;
}): RunScheduleAdapter {
  if (input.trigger === null) return "none";
  if (input.screen === "schedule_tab") {
    return shouldShowPersistentTab(input.trigger) ? "schedule_tab" : "none";
  }
  return shouldShowPersistentTab(input.trigger) || input.fromProposal === true
    ? "rail_step"
    : "none";
}

/** Terminal run statuses — no dispatch left (cinatra#2482). */
export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed" || status === "stopped";
}

/**
 * Should /trigger say, above the schedule form, that this run is already over?
 * (cinatra#2482)
 *
 * The reported repro ends on this screen with no indication that the run has
 * finished, so the state has to be stated. Two things must BOTH hold:
 *
 *   1. a trigger row already EXISTS — the trigger step is done, so this visit
 *      is a RE-arm. Without this half the rule fires on the genuine
 *      setup-success flow (cinatra#580): a run that finished setup is
 *      `completed` with NO trigger row and is redirected here precisely so the
 *      user can choose one. (Caught by a live walk, not by review.)
 *   2. the run is TERMINAL — an immediate re-arm has nothing left to dispatch,
 *      and `setRunTriggerForActor` refuses exactly that.
 *
 * It gates the NOTICE only — whether the form beneath it can still be USED is a
 * separate question about the SCHEDULE rather than about the run, and
 * `shouldFreezeFiredOneOffSchedule` below answers it (cinatra#2980).
 *
 * Exported so the regression test can lock BOTH halves without a DB or session.
 */
export function shouldShowFinishedRunNotice(
  trigger: { triggerType: string } | null,
  runStatus: string | null | undefined,
): boolean {
  return trigger !== null && isTerminalRunStatus(runStatus);
}

/**
 * Has this run's OWN schedule already fired, so that it can no longer be changed
 * here? (cinatra#2980)
 *
 * Plan (A) §7.2 item 4 (amended 2026-08-25): "You can change the schedule this
 * way for as long as it has not fired; once a one-off has fired it cannot be
 * changed, and a change to a recurring schedule applies to its future runs."
 *
 * **Run right after setup** is a one-off, and its row is `immediate`. The screen
 * used to read that word as "no schedule to speak of" and kept offering the
 * form, so a finished run's own trigger row could be replaced with a recurring
 * schedule — the thing the plan's sentence forbids. The rule is read off the
 * TRIGGER, exactly as the server reads it:
 *
 *   - `releasedAt` is the fired stamp — written when the gate opens, for an
 *     immediate fire as much as for a scheduled one. It is the schedule's own
 *     record, never the run's status, which moves for reasons of its own.
 *   - everything that is NOT recurring is a one-off. Written this way round, a
 *     one-off kind added later is frozen by default instead of slipping through
 *     unnamed, which is how `immediate` slipped through.
 *   - a RECURRING schedule is never frozen by a fire: plan (A) §7.2 keeps its
 *     scheduler editable, "and a change applies to its future runs".
 *
 * The same predicate the server enforces (`setRunTriggerForActor`'s fired-one-off
 * guard), so the screen never offers what the server would refuse.
 */
export function shouldFreezeFiredOneOffSchedule(
  trigger: { triggerType: string; releasedAt: Date | null } | null,
): boolean {
  return (
    trigger !== null &&
    trigger.triggerType !== "recurring" &&
    trigger.releasedAt !== null
  );
}

/**
 * The words above the standalone schedule form, or none (cinatra#2482, #2980).
 *
 * Two independent facts, and the copy says only the ones that hold:
 *
 *   - `finished` — the RUN is over. It cannot be run again.
 *   - `frozen`   — its one-off SCHEDULE has fired. It cannot be changed, and the
 *     form below is drawn as a read-only reading.
 *
 * The earlier copy promised what the form no longer does ("You can still give it
 * a recurring schedule below"), which is the half of cinatra#2980 a reader could
 * see. What replaces it names the action that DOES work — starting a new run —
 * in the same words the server's refusal uses, so a person who submits anyway is
 * not told two different things.
 *
 * Exported so the copy is pinned by a test rather than by a reading of the JSX.
 */
export function finishedRunNoticeCopy(input: {
  finished: boolean;
  frozen: boolean;
}): { heading: string; body: string } | null {
  if (!input.finished && !input.frozen) return null;
  const heading = input.finished
    ? "This run has already finished"
    : "This run's schedule has already run";
  if (!input.frozen) {
    // A terminal run whose row never released: the run is over, but its schedule
    // is not spent, so the form still applies and nothing is promised about it.
    return { heading, body: "It can't be run again." };
  }
  return {
    heading,
    body: input.finished
      ? "It can't be run again, and its schedule has already run — a schedule that has run can't be changed. Start a new run to schedule it again."
      : "A schedule that has run can't be changed. Start a new run to schedule it again.",
  };
}

// ---------------------------------------------------------------------------
// WHICH run panel the run-detail body mounts — and therefore which surface owns
// the `run_card` lifecycle host (cinatra#2573, epic #2564 D-1).
//
// The branch itself is not new; it is lifted out of the JSX because a SECOND
// reader now depends on it. `AgenticRunPanel` (reached through
// `SetupCompletionWatcher`) declares `LifecycleCardSurfaceProvider host="run_card"`
// and mounts `RecommendationHoldCard` itself, so the screen must NOT mount a
// second one on that branch — a duplicate decided summary is exactly the
// four-renderer defect this slice retires. Keeping the branch inline in two
// places is how the two would drift back apart.
// ---------------------------------------------------------------------------

/** The four shapes the run-detail right column can take. */
export type RunDetailPanelKind = "none" | "trigger" | "stepper" | "agentic";

/**
 * Resolve the run-detail panel branch from the run + template shape.
 *
 * `"none"` is the PENDING_INPUT case: neither panel renders, because there is no
 * execution to show yet. That is the case the recommendation hold lives in — a
 * held run IS `pending_input` — which is why the screen has to host the card
 * itself rather than leaving it to a panel that is not on the page.
 *
 * `"trigger"` is the PENDING_TRIGGER case (cinatra#2952). `pending_trigger`
 * MEANS "setup is finished and the trigger step is open, awaiting the user's
 * choice" (`run-status.ts`), so the run owes that step before anything may
 * dispatch. Until this branch existed the status fell through to the SETUP
 * branch below, and a run that had just cleared its setup approval was served
 * the settled setup card again: its only control re-submitted the approval,
 * which `approveReviewTaskInternal` refuses ("… is not pending_approval"), and
 * no `agent_run_triggers` row was ever created.
 *
 * WHY ONLY SOME AGENTS. The one route into the scheduling step was
 * `SetupCompletionWatcher`'s /trigger redirect, and that watcher is mounted on
 * the `agentic` branch ALONE. An agent whose approval policy carries renderer
 * gates lands on `stepper` instead — `buildRunStepperSteps` projects those
 * gates into steps — so its run page never mounted the watcher and had no route
 * into the step by any entry path, while a sibling whose policy carries no
 * renderer gate landed on `agentic`, was redirected, and got its row. (The
 * redirect is switched off again by `noRedirect` for orchestrator/flow
 * templates and child runs, which closes the remaining ways in.) The step is
 * drawn HERE instead of routed to, so no client redirect decides whether the
 * person can go on.
 *
 * `hasTriggerRow` is the other half of that branch, and it is not optional: a
 * run that already HAS its row is PAST the step, so handing it the form again
 * is the re-arm loop cinatra#2482 closed. Take it from
 * `readRunTriggerByRunId`, never from the status alone.
 *
 * Exported so the regression test can pin the branch table (and the host
 * ownership derived from it) without a DB, a session or a Next.js render.
 */
export function runDetailPanelKind(params: {
  runStatus: string | null | undefined;
  templateType: string | null | undefined;
  sourceType: string | null | undefined;
  stepperStepCount: number;
  /** Does an `agent_run_triggers` row already exist for this run? */
  hasTriggerRow: boolean;
}): RunDetailPanelKind {
  const { runStatus, templateType, sourceType, stepperStepCount, hasTriggerRow } = params;
  if (runStatus == null || runStatus === "pending_input") return "none";
  if (runStatus === "pending_trigger" && !hasTriggerRow) return "trigger";
  const stepper =
    (templateType === "orchestrator" || templateType === "flow" || stepperStepCount > 0) &&
    sourceType !== "external";
  return stepper ? "stepper" : "agentic";
}

/**
 * Does the run-detail SCREEN mount the one `recommendation_hold` card itself?
 *
 * TRUE unless the panel below already declares `run_card` and draws it. There is
 * no third answer: every branch draws the card exactly once, either here or in
 * the panel, so the interaction has ONE renderer on this surface at all times.
 *
 * The `trigger` branch (cinatra#2952) mounts no run panel at all, so the screen
 * keeps the card there, exactly as it does on `none` and `stepper`.
 */
export function screenHostsRecommendationCard(panel: RunDetailPanelKind): boolean {
  return panel !== "agentic";
}

/**
 * Does the run-detail SCREEN mount the page-level step rail (`RunStepRailPanel`)
 * itself? (cinatra#2739)
 *
 * THE DEFECT THIS CLOSES. The screen mounted `RunStepRailPanel` unconditionally
 * beside the right-hand panel, and on the `stepper` branch that panel mounts a
 * rail of its OWN (`StepperColumn`). Both project the same approval policy
 * through `buildRunStepperSteps` — the screen's rail spine literally IS
 * `hitlSteps` — so a flow-agent run detail drew the same five steps TWICE, side
 * by side: the left column plain, the right one with the ⓘ tooltips. Owner
 * ruling 2026-08-14: exactly ONE column.
 *
 * WHICH RAIL OWNS IT. The panel's column, whenever it draws one. Its active
 * step, pause state, replay clicks, dev stepper and ⓘ tooltips are all bound to
 * the panel's live run-stream state, which a server-rendered rail cannot carry;
 * the deep links the page rail owned move DOWN into it as `railExtras`. So the
 * screen stands down exactly when the panel raises a rail — the stepper branch
 * WITH steps. A stepper panel with NO steps renders no column at all (it
 * returns the step-less "Agentic Run Progress" section), so the screen keeps the
 * rail there: suppressing it would drop the run's review links entirely.
 *
 * THE TRIGGER BRANCH KEEPS THE RAIL (cinatra#2952). The scheduling step raises
 * no column of its own, and Agents Lifecycle (A) §7 puts it "to the right of the
 * steps" — so the steps stay on the left and the step opens beside them.
 *
 * Exported so the regression test can pin the whole branch table without a DB,
 * a session or a Next.js render.
 */
export function screenHostsStepRail(params: {
  panel: RunDetailPanelKind;
  stepperStepCount: number;
}): boolean {
  return !(params.panel === "stepper" && params.stepperStepCount > 0);
}

/**
 * Does the run detail draw the page's OWN rail rows at all? (cinatra#2790, S9f)
 *
 * The screen used to answer this inline, and one clause of it was
 * `run.status !== "pending_input"`: a run that has not been dispatched has no
 * work in progress for a rail to point at, so it drew none.
 *
 * THAT CLAUSE IS WRONG THE MOMENT A GATE STEP HEADS THE RAIL. A run HELD at its
 * skills question IS `pending_input`, and plan (A) §6.2 puts that row "at the
 * trigger position, the top entry on the step rail, ahead of the work steps it
 * would authorize" — a rail holding the gate row alone shows nothing for it to
 * be ahead of, which is the reading the plan asks for and not one it allows.
 * So the pre-dispatch suppression survives for a run with NO gate step, and
 * stands down for one that has any.
 *
 * Nothing else moves: an empty rail is still no rail, and the stepper branch's
 * own live column is still the one rail where it draws (`screenHostsStepRail`).
 *
 * Exported so the regression test can pin the whole table without a DB, a
 * session or a Next.js render.
 */
export function screenDrawsPageRail(params: {
  runStatus: string | null | undefined;
  railEntryCount: number;
  gateStepCount: number;
  panel: RunDetailPanelKind;
  stepperStepCount: number;
}): boolean {
  if (params.railEntryCount === 0) return false;
  if (params.runStatus === "pending_input" && params.gateStepCount === 0) return false;
  return screenHostsStepRail({
    panel: params.panel,
    stepperStepCount: params.stepperStepCount,
  });
}
/** The statuses that ARE an execution: the run fired and is in it, or died in it. */
const EXECUTING_RUN_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "pending_approval",
  "waiting_trigger",
]);

/**
 * HAS THIS RUN ACTUALLY RUN? (cinatra#2788, S9d)
 *
 * Plan (A) §7.2 step 5: the schedule step "opens to the right of the steps …
 * and no agentic run progress card is shown with it" — because a run whose
 * schedule has not fired has produced no progress. Status alone cannot answer
 * it: `completed` is ambiguous (setup-success awaiting a trigger vs a finished
 * execution) and `stopped` is what a CANCELLED schedule leaves behind, so for
 * the terminal statuses the RECORD is the answer — persisted step results, run
 * messages, or streamed text. For the live statuses the status is the record.
 *
 * Exported so the regression test can pin the whole table without a DB, a
 * session or a Next.js render.
 */
export function runHasExecutionRecord(params: {
  runStatus: string | null | undefined;
  stepResultCount: number;
  runMessageCount: number;
  streamedTextLength: number;
}): boolean {
  const { runStatus } = params;
  if (runStatus == null || PRE_EXECUTION_RUN_STATUSES.has(runStatus)) return false;
  if (EXECUTING_RUN_STATUSES.has(runStatus)) return true;
  return (
    params.stepResultCount > 0 ||
    params.runMessageCount > 0 ||
    params.streamedTextLength > 0
  );
}

/**
 * DO THE RUN'S STILL-TO-COME ROWS RIDE ON THE RAIL? (cinatra#3068 fix leg 3)
 *
 * The ratified drawing: "A resolved gate stays on the rail as read-only history
 * -- its entry keeps its place", "steps already passed sit above it, steps still
 * to come below", "so the rail is the run's whole lifecycle at a glance, not
 * just its live tip."
 *
 * Fix leg 2 drew those rows only while the form was still OPEN. So the moment a
 * person answered the run's first step, four rows became one: the settled entry
 * stood alone and the rail was the live tip again -- the one reading the drawing
 * forbids, measured on the third graded reading of this branch.
 *
 * THE ROWS RIDE FOR AS LONG AS THE RAIL CARRIES THE RUN'S INPUT STEPS, which is
 * exactly the span that includes the answered form the drawing keeps.
 *
 * AND THEY STOP WHERE THE RUN'S OWN HISTORY STARTS. Once the run has produced an
 * execution record its later rows are its REAL ones, drawn by their own steps;
 * appending "not reached yet" placeholders beside them would draw a run steps it
 * has already taken another way, or will never take at all.
 */
export function railDrawsUpcomingRunSteps(params: {
  inputStepIsOpen: boolean;
  inputStepsInRail: boolean;
  hasExecution: boolean;
}): boolean {
  if (params.inputStepIsOpen) return true;
  return params.inputStepsInRail && !params.hasExecution;
}

/**
 * The setup flow's own three steps, in the order the rail draws them -- the same
 * three the schedule screen's rail names.
 */
export const UPCOMING_RUN_RAIL_STEP_KEYS = [
  "schedule",
  "recommendation",
  "review",
] as const;

export type UpcomingRunRailStepKey = (typeof UPCOMING_RUN_RAIL_STEP_KEYS)[number];

/**
 * WHICH of those three the rail still owes, given what it has already drawn.
 *
 * NEVER TWICE: a key the rail already drew -- a live recommendation hold, an
 * armed schedule -- keeps the row it has, so the de-duplication is part of this
 * answer rather than a guard at the call site that a later caller could forget.
 */
export function upcomingRunRailStepKeys(params: {
  drawUpcoming: boolean;
  drawnKeys: readonly string[];
}): UpcomingRunRailStepKey[] {
  if (!params.drawUpcoming) return [];
  const drawn = new Set(params.drawnKeys);
  return UPCOMING_RUN_RAIL_STEP_KEYS.filter((key) => !drawn.has(key));
}

/**
 * WHICH TAB THE RUN PAGE LIGHTS (cinatra#3068 fix leg 3).
 *
 * The ratified drawing, on a step drawn inside this frame: "A step shown inside
 * the frame selects nothing ... no tab is drawn selected." The run's first step
 * -- the agent's own input form -- is drawn inside the frame on the run's own
 * path, and this page lit Setup under it, so the strip told the reader they were
 * in the body of a tab while what stood there was a step.
 *
 * `"none"` names no trigger the strip carries, so nothing is drawn selected and
 * the strip itself is unchanged: the same tabs on every route, which is the
 * constant frame cinatra#2487 bought. Every other moment on this path keeps the
 * Setup tab it has always lit.
 *
 * AND THE ANSWERED FORM IS STILL THAT STEP (convergence on this leg). The first
 * reading asked only whether the form was OPEN, so the moment a person answered
 * it and pressed its row on the rail, its read-only screen stood in the frame
 * with Setup lit again -- the same contradiction, one press later. The span the
 * answer reads is therefore the whole span in which the rail carries the run's
 * input steps: for as long as the frame is drawing them, the frame is drawing a
 * STEP, and the drawing gives that reading no lit tab. Outside that span --
 * every moment this branch did not add -- the page lights Setup exactly as it
 * always has, so the gate steps tracked elsewhere are left as they are.
 *
 * AND THE SCHEDULE STEP IS A STEP IN THIS FRAME TOO (the merge-forward with
 * cinatra#3182 item 8). Both readings answer the SAME prop -- the run page draws
 * one tab strip -- so the page cannot ask them one at a time. It asks this one,
 * which owns the run's own input span and hands the schedule span to
 * `runPageScheduleStepActiveTab` below, so neither reading is restated here and
 * a step drawn inside the frame lights no tab whichever step it is.
 */
export function runPageActiveTab(params: {
  inputStepIsOpen: boolean;
  inputStepsInRail: boolean;
  scheduleStepInFrame: boolean;
}): "setup" | "none" {
  if (params.inputStepIsOpen || params.inputStepsInRail) return "none";
  return runPageScheduleStepActiveTab({
    scheduleStepInFrame: params.scheduleStepInFrame,
  });
}

/**
 * NO TAB IS LIT WHILE THE SCHEDULE STEP STANDS IN THE FRAME (cinatra#3182
 * item 8).
 *
 * Application Design — Agents, the run view's conditional-tab section: "Then the
 * strip is the two-tab reading — Setup and Permissions — and no tab is drawn
 * selected: what sits under the strip is that step, not the body of a tab, so
 * none of the tabs is lit for it. ... A step drawn inside this frame never
 * lights a tab the strip does not carry."
 *
 * The run page drew that step and lit Setup under it, so the strip told the
 * reader they were in the body of the Setup tab while what stood there was the
 * scheduling step. `"none"` names no trigger the strip carries, so nothing is
 * drawn selected and the strip itself is unchanged. Every other moment on this
 * path keeps the Setup tab it has always lit.
 *
 * Exported so the regression test can read the rule without a DB or a render.
 */
export function runPageScheduleStepActiveTab(params: {
  scheduleStepInFrame: boolean;
}): "setup" | "none" {
  return params.scheduleStepInFrame ? "none" : "setup";
}

/**
 * AND THE SAME ANSWER ON THE SCHEDULE ROUTE (cinatra#3182 item 8; this is also
 * the residual cinatra#3168 names).
 *
 * The route mounted the frame on the schedule tab unconditionally. While
 * the run carries a persisted scheduled/recurring row the strip DOES draw that
 * tab and lighting it is right. While it does not — the transient first-step
 * scheduling gate — the route was naming a tab the strip does not render at
 * all: a reference to an absent tab, and a step lighting a tab either way.
 *
 * Exported for the same reason as the reading above.
 */
export function scheduleRouteActiveTab(params: {
  persistentScheduleTab: boolean;
}): "trigger" | "none" {
  return params.persistentScheduleTab ? "trigger" : "none";
}

/**
 * WHICH STEP THE RUN DETAIL OPENS ON (cinatra#2788, S9d).
 *
 * The ratified drawing: "the run detail on the right shows the selected step",
 * and the step the run is paused on is the highlighted one. So a run that is
 * held at its skills question opens on the run detail, where that hold is drawn;
 * a run that has executed opens on its own progress; and a run that has neither
 * — armed, not yet fired, cancelled or expired — opens on the schedule step,
 * which is the only step it has (plan (A) §7.2 step 5).
 */
export function runDetailOpensOnSchedule(params: {
  hasScheduleStep: boolean;
  hasExecution: boolean;
  recommendationHeld: boolean;
}): boolean {
  return params.hasScheduleStep && !params.hasExecution && !params.recommendationHeld;
}

/**
 * Can this run still REACH `pending_trigger`, and therefore still owe the
 * scheduling step? (cinatra#2952)
 *
 * `TriggerStepWatcher` is mounted on exactly this answer, so the run row it
 * polls is read only while the transition it waits for is still possible. Two
 * edges lead into `pending_trigger` (`run-status.ts`): from `pending_input` and
 * from `queued` — and the setup gate's `pending_approval` resumes THROUGH
 * `queued`, which is the path this issue is about. Anything past that —
 * `running`, `waiting_trigger`, `armed`, terminal — can no longer reach it, so
 * the watcher stands down rather than reading the run forever.
 *
 * Two runs never owe the step at all: one that already HOLDS a trigger row (it
 * is past the step — cinatra#2482's re-arm loop), and a CHILD run, whose
 * dispatch is governed by its parent's trigger and which has no step of its own.
 *
 * Exported so the regression test can pin the whole table without a DB.
 */
export function runMayReachTriggerStep(params: {
  runStatus: string | null | undefined;
  hasTriggerRow: boolean;
  isChildRun: boolean;
}): boolean {
  if (params.hasTriggerRow || params.isChildRun) return false;
  return (
    params.runStatus === "pending_input" ||
    params.runStatus === "pending_approval" ||
    params.runStatus === "queued"
  );
}

/**
 * WHICH STEP THE RUN DETAIL OPENS ON, over BOTH gate steps (cinatra#2790, S9f).
 *
 * The S9d answer above is unchanged and is still the schedule's own half; this
 * is the whole ladder, in the order the rail draws the steps. Plan (A) §6.2 puts
 * the recommendation "at the trigger position, the top entry on the step rail,
 * ahead of the work steps it would authorize", and the drawing highlights the
 * step the run is PAUSED on — so a LIVE hold is the open step, ahead of a
 * schedule the run cannot have reached yet. A decided hold opens nothing of its
 * own: the run detail returns to what the run page otherwise shows, and the row
 * stays in the rail as the resolved-gate history row.
 *
 * Exported so the regression test can pin the whole table without a DB, a
 * session or a Next.js render.
 */
export function runDetailInitialStep(params: {
  hasRecommendationStep: boolean;
  recommendationHeld: boolean;
  hasScheduleStep: boolean;
  hasExecution: boolean;
  /**
   * THE RUN'S OWN INPUT FORM, WHERE ONE IS BEING ASKED (cinatra#3068).
   *
   * It heads the ladder because it heads the rail: a run standing at its input
   * form is standing at the step the drawing highlights, and the form is that
   * step's screen. `null` — which is every moment no form is open, including a
   * run that has not been dispatched yet — leaves the S9d/S9f ladder below
   * exactly as it was.
   */
  openInputStepKey?: RunInputStepKey | null;
}): RunStepSelection {
  if (params.openInputStepKey) return params.openInputStepKey;
  if (params.hasRecommendationStep && params.recommendationHeld) return "recommendation";
  if (
    runDetailOpensOnSchedule({
      hasScheduleStep: params.hasScheduleStep,
      hasExecution: params.hasExecution,
      recommendationHeld: params.recommendationHeld,
    })
  ) {
    return "schedule";
  }
  return "detail";
}

type ScreenProps = {
  agentId: string;          // template slug from URL
  instanceId: string;       // runId or "new"
  searchParams?: Record<string, string | string[] | undefined>;
};

/**
 * The header's "this run came from extension X" link, which addresses the
 * marketplace listing under `/configuration` — admin-only since cinatra#2700
 * (epic #2699). `viewerIsAdmin` is therefore required: a member sees the run
 * screen unchanged, minus a link that would land on not-authorized.
 */
function buildExtensionHeaderLink(
  packageName: string | null | undefined,
  viewerIsAdmin: boolean,
) {
  if (!packageName || !viewerIsAdmin) return null;
  const match = /^@([^/]+)\/(.+)$/.exec(packageName);
  if (!match) return null;
  return {
    extensionIdentifier: packageName,
    extensionHref: `/configuration/marketplace/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`,
  };
}

async function resolveTemplateForActor(agentId: string) {
  const session = await getAuthSession();
  // admin-parity P4 (cinatra#1129): resolve the actor's admin-standing bag so a
  // platform_admin / owning-org admin can open a non-published template, not
  // just its creator.
  return readAgentTemplateBySlug(
    agentId,
    await resolveTemplateVisibilityActor(session),
  );
}

// ---------------------------------------------------------------------------
// SetupScreen uses a single code path for pre-run and mid-run user interaction:
// the agent-builder dispatcher emits AG-UI INTERRUPTs for missing fields and
// the AgenticRunPanel renders them inline via fieldRendererRegistry.
//
//  - /new does not auto-create a run: the user must explicitly click
//    "Start new run".
//  - The Setup tab is a distinct view from Run. It renders a read-only
//    summary of required fields from inputSchema (showing the values
//    already collected in run.inputParams), not the AgenticRunPanel. The
//    Run tab owns AgenticRunPanel; Setup remains a calm pre-run surface.
// Serialize AgentRunMessageRecord rows for the client panels (Date → ISO
// string). Shared by SetupScreen (executed-run output, cinatra#831) and
// RunScreen.
function serializeRunMessages(
  rawMessages: Awaited<ReturnType<typeof readAgentRunMessages>>,
): SerializedAgentRunMessage[] {
  return rawMessages.map((m) => ({
    id: m.id,
    runId: m.runId,
    sequence: m.sequence,
    role: m.role,
    messageType: m.messageType,
    toolCallId: m.toolCallId,
    toolName: m.toolName,
    body: m.body,
    createdAt: m.createdAt instanceof Date ? m.createdAt.toISOString() : (m.createdAt as string),
  }));
}

export async function SetupScreen({ agentId, instanceId }: ScreenProps) {
  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;

  // Fast path: fetch session + template once, pass them directly to the core
  // run-creation logic — avoids the two redundant re-fetches that the slug-based
  // public variant would perform.
  if (instanceId === "new") {
    if (!actorUserId) notFound();
    // orgId is required at agent_runs insert time.
    // createAndTriggerRunWithContext takes (userId, orgId, template) — we
    // resolve orgId here from the same session we already have in scope.
    const actorOrgId = session?.session?.activeOrganizationId ?? null;
    if (!actorOrgId) notFound();
    const template = await readAgentTemplateBySlug(agentId, {
      actorUserId,
      includeNonPublished: true,
    });
    if (!template) notFound();
    const result = await createAndTriggerRunWithContext(actorUserId, actorOrgId, template);
    if (result.ok) {
      redirect(`/agents/${agentId}/${encodeURIComponent(result.runId)}`);
    }
    notFound();
  }

  // Better Auth stores role as "user,admin" for multi-role users; naive
  // === "admin" misses them.
  const isAdmin = isPlatformAdmin(session);
  const template = await readAgentTemplateBySlug(agentId, {
    actorUserId,
    includeNonPublished: true,
  });
  if (!template) notFound();

  // Pass actor + roles so readAgentRunById
  // enforces effectivePolicy (runDataVisibility) in addition to ownership.
  // Without actor context, the policy gate is skipped and a co-owner on a
  // template with runDataVisibility:"admin" could view run data via SSR.
  // Access denial is surfaced as AuthzError and mapped to notFound() below.
  const setupActor: PrimitiveActorContext = { actorType: "human", source: "ui", userId: actorUserId ?? undefined };
  const setupRoles: ActorRoleHints = {
    platformRole: isAdmin ? "platform_admin" : "member",
    // admin-parity P4 (cinatra#1129): thread the actor's active-org role so the
    // owner-aware run "admin" visibility tier recognizes an org admin/owner.
    orgRole: session
      ? await resolveOrgRoleForSession({ user: { id: session.user.id }, session: session.session })
      : undefined,
    actorOrganizationId: session?.session?.activeOrganizationId ?? undefined,
  };
  let run: Awaited<ReturnType<typeof readAgentRunById>> = null;
  if (instanceId !== "new") {
    try {
      run = await readAgentRunById(instanceId, setupActor, setupRoles);
      if (!run) notFound();
    } catch (err) {
      if (err instanceof AuthzError) notFound();
      throw err;
    }
  }

  // cinatra#2933 — the window's own access answer for this run. `true` with no
  // run: there is nothing to ask, and the screen keeps the box it has today.
  const canRespondInWindow = run ? await canRespondInRunWindow(run.id) : true;

  // Defensive: inputSchema is typed as Record<string, unknown> on the
  // template record; narrow it here for the summary render below.
  const inputSchema = (template.inputSchema ?? {}) as {
    properties?: Record<string, { title?: string } & Record<string, unknown>>;
    required?: string[];
  };
  const required = inputSchema.required ?? [];
  const properties = inputSchema.properties ?? {};
  const inputParams = (run?.inputParams ?? {}) as Record<string, unknown>;
  const setupComplete = required.every((f) =>
    Object.prototype.hasOwnProperty.call(inputParams, f),
  );

  // Only real HITL renderer gates appear in the stepper — steps with an
  // xRenderer that are NOT #839 metadata-only phantom gateSteps (a FlowNode
  // review gateStep whose subflow fires no runtime pause). Shared predicate
  // keeps this walk in lockstep with the live resolver (execution.ts) and the
  // replay submission map (run-actions.ts); a mismatch shifts every prompt→step
  // mapping by one slot.
  const policySteps = template.approvalPolicy?.steps ?? [];
  // Shared with the agent-run review surface via buildRunStepperSteps (cinatra#2063)
  // so both surfaces render the identical step list in lockstep.
  const hitlSteps = buildRunStepperSteps(policySteps as ReadonlyArray<RunStepperPolicyStep>, {
    // The run's own record of each step, for a declaration that names nothing
    // (cinatra#3226): a work step is named by its work, never by an ordinal.
    stepResults: (run?.stepResults ?? null) as readonly unknown[] | null,
  });

  // Batch-fetch sub-agent descriptions for tooltip content.
  const childPackages = Array.from(new Set(
    hitlSteps.map(s => s.childAgentPackageName).filter((p): p is string => Boolean(p))
  ));
  const subAgentDescriptionMap = new Map<string, string>();
  if (childPackages.length > 0) {
    await Promise.all(childPackages.map(async (pkg) => {
      const matches = await readAgentTemplates({ packageName: pkg, limit: 1 });
      const desc = matches.items[0]?.description;
      if (desc) subAgentDescriptionMap.set(pkg, desc);
    }));
  }

  const stepperSteps = [
    ...hitlSteps.map(({ _policyDescription, childAgentPackageName, ...s }) => ({
      ...s,
      childAgentPackageName,
      description:
        (childAgentPackageName ? subAgentDescriptionMap.get(childAgentPackageName) : undefined) ??
        _policyDescription ??
        undefined,
    })),
  ];

  // Server-side build of submission map for completed-step replay.
  // First paint is server-rendered (no client fetch on initial load); the stepper
  // re-fetches via server action on interruptContext non-null → null transitions.
  //
  // Skip the call entirely when
  // template.packageName is null instead of passing "" — an empty-string
  // agentId silently runs a meaningless `WHERE agent_id = ''` query and
  // hides the trail for legacy / external templates without surfacing the
  // condition. Mirrors the client-side guard at orchestrator-stepper-panel.tsx
  // (`agentPackageName && ...`) so server-render and client-refetch agree.
  const submissionMap: SubmissionMapEntries =
    run && template.packageName
      ? await buildSubmissionMapByStepIndex(
          run.id,
          template.packageName,
          policySteps as ReadonlyArray<{ stepNumber: number; gateCount?: number; hitlOwnedBy?: string; xRenderer?: string; firesRendererGate?: boolean }>,
          hitlSteps.map((h) => ({ index: h.index, stepNumber: h.stepNumber })),
        )
      : [];

  // Trigger gate: if no trigger row exists, replace workspace content
  // with the first-step trigger form.
  const trigger = run ? await readRunTriggerByRunId(run.id) : null;
  // ── §VI's card, reached through the run page's SCHEDULE STEP ──────────────
  // (cinatra#2788, epic #2784 S9d)
  //
  // WHERE IT DRAWS. Plan (A) §7.2 step 5: "On the run page and the review page
  // the schedule is a **dedicated step in the step rail on the left, above
  // '1 Review'**: open that step to see the configuration or change it. The
  // schedule is never drawn as a card among the review cards." §9's table row
  // makes it this slice's work: "no schedule step in the rail today; the armed
  // schedule has Cancel / Release on a Trigger tab → S9d makes the schedule a
  // dedicated step above '1 Review'". So the card no longer sits in the trigger
  // screen's body — it is the first ROW of this page's left rail, and the rail
  // renumbers itself around it (`stepOffset`).
  //
  // ONLY FOR A RUN THAT HAS A SCHEDULE. A run with no trigger row has nothing
  // for the step to open onto — the card would resolve `absent` and draw no DOM
  // — so no step is drawn at all rather than an empty one. Presence is all this
  // decides; WHAT the step may show is re-resolved against the live reader on
  // the endpoint, which answers `absent` for a run this reader did not confirm a
  // proposal for. A run that cannot mint a ref (no app secret) draws none either.
  //
  // AND ONLY WHERE THE STEP OPENS ONTO SOMETHING (cinatra#3004). The card the
  // step mounts draws no DOM at all for a row its resolver answers `absent`
  // for, so a step offered for such a row is a rail row that opens an empty
  // column. The picker reads the resolver's own allow-list; the one row it
  // cannot decide from the trigger type alone is a run created by confirming a
  // schedule stated in a CONVERSATION, whose card is drawn whatever kind it
  // settled into — so that one fact is read, and only when it can change the
  // answer.
  const scheduleFromProposal =
    run && trigger && !shouldShowPersistentTab(trigger)
      ? (await readProposalConsumeByRunId(run.id)) !== null
      : false;
  const scheduleRailRef =
    run &&
    runScheduleAdapterFor({
      screen: "run_detail",
      trigger,
      fromProposal: scheduleFromProposal,
    }) === "rail_step"
      ? encodeScheduleRunRef({ runId: run.id })
      : null;
  // cinatra#2487: ONE predicate for the strip on every route (was an inline
  // duplicate of shouldShowPersistentTab here, `!!run` on /trigger, and nothing
  // at all on /permissions — so the strip's contents changed between tabs).
  const showTriggerTab = shouldShowPersistentTab(trigger);

  // `completed` is ambiguous (cinatra#831): genuine setup-success awaiting
  // trigger configuration (the /trigger redirect flow, cinatra#580) vs a
  // fully EXECUTED run. Execution evidence — persisted step results, run
  // messages, or streamed text — marks the latter: those runs must keep
  // their output reachable on the base run URL instead of redirecting to
  // the scheduler, which is a dead end for them (a completed run has no
  // legal transition back into the trigger lifecycle). Messages are loaded
  // only for completed runs — the watcher's panel needs them to render the
  // executed output (LangGraph runs persist output as message rows).
  const completedRunMessages =
    run && run.status === "completed" ? await readAgentRunMessages(run.id) : [];
  const runHasExecuted =
    run !== null &&
    run.status === "completed" &&
    ((run.stepResults?.length ?? 0) > 0 ||
      completedRunMessages.length > 0 ||
      (run.streamedText ?? "") !== "");

  // THE GATE, DERIVED BEFORE THE PAGE IS SERVED (cinatra#2729 defect 2).
  //
  // A paused run's form used to appear only after the client's first stream
  // frame or poll tick, so the same run showed the formless "awaiting human
  // approval" banner or its actionable setup-field form depending on which
  // entry path the reader took and how fast that path hydrated. Everything the
  // derivation needs is already loaded here, so the panel is handed the gate
  // for its first paint and every entry path renders the same screen.
  //
  // Best-effort and read-only: the derivation reads the run's latest interrupt,
  // so a Redis hiccup must degrade to the previous client-hydrated behaviour,
  // never to a failed page render. `deriveRunHitlContext` itself returns null
  // for any run that is not paused.
  const initialHitlContext = run
    ? await deriveRunHitlContext(run, { template }).catch(() => null)
    : null;

  // ── THE RUN'S OWN INPUT STEPS (cinatra#3068) ─────────────────────────────
  //
  // The first step a person meets on this page is the agent's own input form,
  // and it was the ONE moment of the run that did not read as a step: it was
  // drawn inside a step-less "Agentic Run Progress" panel with no step list
  // beside it, while every later moment is an entry in the rail with its own
  // screen in the detail column. The forms are named here, from the template's
  // declared inputs and what the run already carries — the same walk the setup
  // loop makes — so the rail can carry them from this page's FIRST render.
  //
  // WHICH form is open is the run's own answer, and the discriminator is the
  // interrupt rather than the status: a setup-loop pause and a mid-run review
  // gate are both `pending_approval`.
  //
  // AND THE WHOLE DESCRIPTOR IS HANDED OVER, not the task id alone (cinatra#2928).
  // The moment is read by the one classifier every other surface asks, and that
  // reader needs the run's own recorded moment beside the derived gate context
  // — the same pair the status badge is handed. Narrowing this to a review-task
  // id would leave the rail re-deriving the moment from the retired `setup-`
  // prefix, so a run that STATES it waits at a field, and a setup payload
  // carried as a field name, would draw no first step while the badge beside it
  // already read "Awaiting input".
  //
  // THE RESOLVED SCHEMA, not the stored one: `execution.ts` walks
  // `resolveTemplateInputSchema(template)`, which derives the fields from the
  // installed agent's OAS when the row's own schema is empty. Reading
  // `template.inputSchema` here would name no step for precisely the agents
  // whose form the loop still asks (cinatra#3068 convergence).
  const resolvedInputSchema = await resolveTemplateInputSchema(template);
  const runLifecycleMoment = run?.lifecycleMoment ?? null;
  const atInputMoment = runAtInputMoment({
    runStatus: run?.status ?? null,
    interrupt:
      initialHitlContext === null && runLifecycleMoment === null
        ? null
        : { ...(initialHitlContext ?? {}), lifecycleMoment: runLifecycleMoment },
  });
  const runInputSteps = buildRunInputSteps({
    required: resolvedInputSchema.required,
    properties: resolvedInputSchema.properties,
    inputParams,
    atInputMoment,
  });
  // AND ONLY WHILE THE RUN IS AT ITS INPUT. Once every form is answered the run
  // has left its first step behind and this rail is the schedule /
  // recommendation / review rail it has always been — and a run that never
  // answered its form but failed, was cancelled, or is paused at a mid-run
  // review gate is not at its input either, so it keeps the surface it had.
  const inputStepsInRail = runCarriesInputSteps(runInputSteps, atInputMoment);
  const openInputStepKey = openRunInputStepKey(runInputSteps);
  // TWO FACTS, NOT ONE (cinatra#3068 fix leg 2). Since the rail keeps an
  // ANSWERED form as read-only history, "the rail carries an input row" and
  // "this panel is drawing the input form" stopped being the same fact. The
  // panels are told the SECOND one: the step-less heading and the run-progress
  // reading retire only while the form is the step being drawn, so a run that
  // has moved on keeps the progress panel -- and its status badge -- it had.
  const inputStepIsOpen = openInputStepKey !== null;

  // Pre-generate a unique run name so the title shows immediately on load.
  // Only runs that have started (not pending_input) get a name here; abandoned
  // pending_input runs skip auto-naming to avoid wasting numbered slots.
  const runName =
    run && run.status !== "pending_input"
      ? await ensureRunTitle(run, template.name)
      : run?.title ?? "";
  const extensionHeaderLink = buildExtensionHeaderLink(
    template.packageName,
    isPlatformAdmin(await getAuthSession().catch(() => null)),
  );

  // ── Canonical run view LEFT RAIL (cinatra#2066, C1) ──────────────────────
  // ONE run-detail contract for BOTH template classes: the merged step rail on
  // the left, the run detail (stepper / transcript panel) on the right. The rail
  // merges the three step sources (template-derived steps + captured submissions;
  // transcript messages; stepResults JSON) and weaves in the run's review gates
  // from C0's `listReviewGatesForRun` — INCLUDING resolved gates as read-only
  // history. Access is already enforced above (readAgentRunById with the actor);
  // `listReviewGatesForRun` is a plain run-scoped read behind that door.
  const railGates = run ? await listReviewGatesForRun(run.id) : [];
  // cinatra#2047 D-5: the run's LIFECYCLE POLICY DECISIONS, read from the run's own
  // produced-event outbox rows. A fired decision already renders as its gate above;
  // a SKIPPED one had no rendering at all before this — so an org-forbidden /
  // default-skip / manifest-skip review was indistinguishable from no lifecycle
  // machinery running. Plain run-scoped read behind the access door already cleared.
  const railLifecycleDecisions = run ? await readLifecycleDecisionsForRun(run.id) : [];
  // S4 (cinatra#2042): the run's post-change verification records, keyed to their
  // gate — woven into the rail as "Audit" entries beneath each gate.
  const railVerifications = railGates.length
    ? await readVerificationRecordsForGates(railGates.map((g) => g.id))
    : [];
  const gateTaskById = new Map(railGates.map((g) => [g.id, g.reviewTaskId]));
  const railTemplateSteps = hitlSteps.map((h) => ({
    index: h.index,
    stepNumber: h.stepNumber,
    label: h.label,
  }));
  const railStepResults = (run?.stepResults ?? []) as unknown[];
  // Transcript only forms the rail spine for a single-agent/leaf run — no policy
  // steps AND no stepResults. Skip the extra read for orchestrator-shaped runs.
  const transcriptFormsSpine = railTemplateSteps.length === 0 && railStepResults.length === 0;
  const railMessages: RailMessage[] =
    run && transcriptFormsSpine
      ? (await readAgentRunMessages(run.id)).map((m) => ({
          id: m.id,
          sequence: m.sequence,
          role: m.role,
          messageType: m.messageType,
          text:
            m.body && (m.body.messageType === "text" || m.body.messageType === "final")
              ? m.body.text
              : null,
        }))
      : [];
  const rail = run
    ? buildRunStepRail({
        templateSteps: railTemplateSteps,
        submissions: submissionMap.map(([stepIndex, entry]) => ({
          stepIndex,
          answered: entry.submittedValues != null,
        })),
        messages: railMessages,
        stepResults: railStepResults,
        gates: railGates.map((g) => ({
          gateId: g.id,
          reviewTaskId: g.reviewTaskId,
          status: g.status,
          disposition: g.disposition,
          createdAt: g.createdAt,
        })),
        verifications: railVerifications
          .filter((v) => gateTaskById.has(v.gateId))
          .map((v) => ({
            gateId: v.gateId,
            reviewTaskId: gateTaskById.get(v.gateId)!,
            outcome: v.outcome,
          })),
        lifecycleDecisions: railLifecycleDecisions.map((d) => ({
          eventId: d.eventId,
          artifactId: d.artifactId,
          outcome: d.outcome,
          gateId: d.gateId,
          decidedBy: d.decidedBy,
          latticeOutcome: d.latticeOutcome,
          reason: d.reason,
          createdAt: d.createdAt,
        })),
      })
    : { entries: [], activeOrdinal: null };
  const reviewHrefBase = run ? `/agents/${agentId}/${encodeURIComponent(run.id)}/review` : "";
  // ── §VII's audit card, on the `run_card` host (cinatra#2789, epic #2784 S9e) ──
  //
  // THE MOUNT. The rail above already weaves an "Audit" ENTRY beneath
  // each gate that has a verification record — a link into the review page's
  // `?view=verification`. That entry is navigation; it is not the reading. This
  // is the reading, drawn on the run page itself under its own
  // `LifecycleCardSurfaceProvider host="run_card"`, so the person looking at the
  // run can see what the audit found without leaving it.
  //
  // ONE REF PER RECORD, AND ONLY WHERE A RECORD EXISTS. The refs are minted
  // from the records this run actually has (`railVerifications`, already read
  // above for the rail — no second query), keyed to the gate's own
  // `reviewTaskId`, so a run with no post-change audit mounts NOTHING and pays
  // for nothing. The card is still the authority on whether it draws: the
  // resolver re-runs the reader's run access and answers `absent` for anyone who
  // may not read the record, and `absent` draws no DOM at all.
  //
  // A RUN THAT CANNOT MINT A REF DRAWS NO CARD, rather than a second
  // composition. An instance with no app secret is a configuration fault to
  // fix, not a reason to fork §VII.
  const verificationCardRefs = run
    ? railVerifications
        .map((v) => gateTaskById.get(v.gateId))
        .filter((reviewTaskId): reviewTaskId is string => Boolean(reviewTaskId))
        .map((reviewTaskId) => ({
          reviewTaskId,
          ref: encodeLifecycleGateRef({ runId: run.id, reviewTaskId }),
        }))
        .filter(
          (entry): entry is { reviewTaskId: string; ref: string } => entry.ref !== null,
        )
    : [];
  // ── THE RUN'S REVIEW SLOT, ON THE RUN PAGE (cinatra#2997) ────────────────
  //
  // "On the run page, the same is true": the run panel below is a placeholder
  // for the review screen while the agent works, and becomes that screen when
  // the work opens one. So this screen answers the question server-side and
  // hands the panel the answer, rather than making the reader watch a spinner
  // for one client read on a page that already knows.
  //
  // BOTH ANSWERS COME FROM THE ONE READER, and the rail's own gate list is NOT
  // used as a shortcut for either. A run can owe a SECOND review — its first
  // gate decided, another artifact produced, its outbox row still pending — and
  // deriving `awaiting` from "does a gate exist" would answer `false` for
  // exactly that run, so the panel would stop looking and sit on the settled
  // card while the next review opened behind it. One extra run-scoped read is
  // the price of an answer that cannot be wrong in that direction.
  const runReviewSlot = run ? await readRunReviewSlot(run.id) : null;
  const initialReviewGate = run
    ? {
        ref: runReviewSlot?.reviewTaskId
          ? encodeLifecycleGateRef({
              runId: run.id,
              reviewTaskId: runReviewSlot.reviewTaskId,
            })
          : null,
        awaiting: Boolean(runReviewSlot?.awaiting),
      }
    : null;
  // cinatra#2739 — the merged rail's NON-SPINE entries: review gates, their
  // verifications, lifecycle policy decisions, and any surplus stepResult row
  // past the policy spine. On the stepper branch the panel's own LIVE column is
  // the rail and it draws the spine itself — from the same `hitlSteps`
  // projection this rail's spine is built from — so only these trailing rows
  // were missing from it. They travel down and the page-level rail stands down.
  //
  // "Non-spine" is decided by KEY, not by kind: the spine entries are exactly
  // `step:<stepNumber>` for the step numbers the panel renders. A surplus
  // stepResult row is also `kind: "step"` and is NOT on the spine, so it must
  // come along — dropping it would lose a step the merged rail showed.
  const spineEntryKeys = new Set(stepperSteps.map((s) => `step:${s.stepNumber}`));
  const railExtras = rail.entries.filter((e) => !spineEntryKeys.has(e.key));

  // ── Run-start recommendation hold — through the ONE card (cinatra#2573) ───
  //
  // WHAT USED TO BE HERE. This screen was a FOURTH renderer of the
  // recommendation interaction: its own park read, its own actor-scoped
  // candidate prefetch, its own decided-summary derivation, and a DIRECT
  // `RunRecommendationChipRow` mount. S4 (cinatra#2568) made
  // `RecommendationHoldCard` THE renderer of `recommendation_hold` — host-gated,
  // and resolved by ONE authoritative server action that re-runs the run-access
  // door and intersects the candidate set against the VIEWER (cinatra#2148) —
  // and moved the run panel and the stepper's dev preview onto it. All of that
  // machinery is deleted here rather than kept in parallel: a second read of the
  // same park, computing the same states through a different code path, is how
  // the two drift and how a held run ends up drawn twice, differently.
  //
  // WHAT THE PARK READ IS STILL FOR, AND ONLY THAT. The Run button is withheld
  // while a hold is LIVE — the human decides the skills first, and it is the
  // confirm/skip inside the card that dispatches the run. That is a property of
  // the run's DISPATCHABILITY, not a rendering of the interaction, so it stays
  // server-side and reads nothing but the park's status. Nothing is prefetched,
  // no candidates are resolved, and no decision state is derived here.
  //
  // THE PARK ROW IS ALSO WHAT SAYS THERE IS A STEP (cinatra#2790, S9f). A rail
  // entry for a run that never held would be a step onto an empty surface — the
  // card draws no DOM at all in that case — so the row's existence is the run's
  // own evidence that this question was ever asked, and its STATUS is the row's
  // reading: live is the step the run is paused on, decided is the history row.
  const recommendationPark = run ? await readRecommendationParkForRun(run.id) : null;
  const recommendationHeld = recommendationPark?.status === "parked";

  // WHICH panel the right column mounts — and therefore whether the card is
  // hosted by this screen or by the panel. See `runDetailPanelKind`.
  const runDetailPanel = runDetailPanelKind({
    runStatus: run?.status ?? null,
    templateType: template.type,
    sourceType: template.sourceType,
    stepperStepCount: stepperSteps.length,
    // cinatra#2952: a run that already holds a trigger row is past the
    // scheduling step; only a run that owes it gets the step drawn.
    hasTriggerRow: trigger !== null,
  });

  // Does the SCREEN own the recommendation card on this branch? On the
  // `agentic` branch the panel inside the run detail mounts the card itself
  // (`screenHostsRecommendationCard`), and a step opening onto a card another
  // module draws would be a second mount of the one renderer.
  const hostsRecommendationCard = screenHostsRecommendationCard(runDetailPanel);

  // IS THERE AN ENTRY, AND HOW DOES IT READ? That is not the same question as
  // "who draws the card" (cinatra#2790, S9f — R6). The ratified run-surface
  // drawing: "A resolved gate stays on the rail as read-only history — its entry
  // keeps its place and records how it was settled." Tying the ENTRY to the host
  // gate made a decided run lose it on this branch — a decided run has been
  // dispatched, so it is no longer `pending_input`, the panel takes the card
  // over, and the row vanished from the rail with the whole frame behind it. A
  // history row does not need a surface of its own to justify its place, so the
  // settled entry survives every branch — on THIS one by opening nothing, and on
  // the branch this screen hosts by opening the same read-only card as before.
  const recommendationEntry = recommendationRailEntry({
    hasPark: recommendationPark !== null,
    held: recommendationHeld,
    hostsCard: hostsRecommendationCard,
  });
  const hasRecommendationStep = recommendationEntry !== "none";

  // Has the agent run at all? A gate step is the run detail's first paint while
  // it has not (cinatra#2788, S9d; cinatra#2790, S9f) — there is no progress to
  // show, and plan (A) §7.2 step 5 forbids showing one with the schedule.
  // READ ONCE, ASKED TWICE (cinatra#3068 fix leg 3): the step the run detail
  // opens on, and whether the rail still owes the run's later steps, are two
  // questions about the same fact -- so the fact is read here and handed to
  // both, rather than derived twice and able to disagree.
  const runHasExecution = runHasExecutionRecord({
    runStatus: run?.status ?? null,
    stepResultCount: run?.stepResults?.length ?? 0,
    runMessageCount: completedRunMessages.length,
    streamedTextLength: (run?.streamedText ?? "").length,
  });
  const initialStep = runDetailInitialStep({
    openInputStepKey,
    hasRecommendationStep,
    recommendationHeld,
    hasScheduleStep: scheduleRailRef !== null,
    hasExecution: runHasExecution,
  });

  // The scheduling step's duration banner, computed ONLY on the branch that
  // draws it (cinatra#2952). `estimateRunDuration` falls through to an LLM
  // analysis when a template has too little run history, so the ordinary run
  // page must never pay for it. Best-effort: the form draws NO duration line at
  // all for a null estimate (cinatra#3182 item 5), which is a better page than
  // a failed render.
  const triggerStepDurationEstimate =
    runDetailPanel === "trigger"
      ? await estimateRunDuration({
          template: { id: template.id },
          compiledOas: { triggerMode: template.triggerMode ?? undefined },
          skillMd: (template.taskSpec ?? "") as string,
        }).catch(() => null)
      : null;

  return (
    <Main className="min-h-screen">
      <AgentPageLayout
        agentId={agentId}
        instanceId={instanceId}
        activeTab={runPageActiveTab({
          inputStepIsOpen,
          inputStepsInRail,
          scheduleStepInFrame: runDetailPanel === "trigger",
        })}
        templateName={template.name}
        initialRunName={runName}
        runId={run?.id ?? null}
        isPublished={template.status === "published"}
        showTriggerTab={showTriggerTab}
        extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
        extensionHref={extensionHeaderLink?.extensionHref}
        actions={
          run && run.status === "pending_input" && !recommendationHeld ? (
            <RunAgentButton
              runId={run.id}
              templateSlug={agentId}
              agentName={template.name}
              allStepsComplete={true}
              runStatus={run.status}
              redirectTo={`/agents/${agentId}/${encodeURIComponent(run.id)}`}
            />
          ) : undefined
        }
      >
        {run ? (
          // Canonical run view (cinatra#2066, C1): the merged step rail on the
          // LEFT (owner ruling 2026-07-25), the run detail on the RIGHT — one
          // contract for both template classes.
          //
          // Declared body role (Application Design — Agents §III, row "Setup —
          // hosting live run progress"): this is monitoring output, not a form,
          // so it takes the FRAME width. Same tab as the configuration form,
          // different panel — which is exactly why the width is declared here
          // and not looked up from `activeTab`.
          <AgentPanelBody role="frame">
          <div className="flex items-start gap-6" data-run-detail-contract="" data-conformance-id="run-surface">
            {(() => {
              // THE ONE `recommendation_hold` MOUNT THIS SCREEN MAKES. It is
              // used in two mutually exclusive slots — the rail step's surface
              // above, and the run detail below — so the interaction still has
              // exactly one renderer on this host at any moment. See the comment
              // on the detail slot for why this screen is a host at all.
              const recommendationCardNode = hostsRecommendationCard ? (
                <LifecycleCardSurfaceProvider host="run_card">
                  <RecommendationHoldCard
                    runId={run.id}
                    agentPackageName={template.packageName ?? ""}
                    wireRef={null}
                  />
                </LifecycleCardSurfaceProvider>
              ) : null;
              // A COLUMN with a GAP, not a margin on the row above. The card
              // below resolves its own state on the client and renders NO DOM at
              // all when there is no hold — the overwhelmingly common case — so a
              // wrapper carrying `mb-4` would leave a 1rem hole above the panel on
              // every ordinary run. A flex gap only ever applies BETWEEN rendered
              // children, which is the spacing that was actually meant.
              // THE RUN DETAIL, COMPOSED BEFORE THE RAIL (cinatra#3068).
              // The rail's own steps are asked whether they can be opened, and
              // that question is answered against the run detail they fall back
              // to — so the detail has to exist before the steps are built. It
              // reads nothing from them, so the move is an ordering only.
              const detailNode = (
                <>
              {/* Run-start recommendation hold, through the ONE card
                  (cinatra#2573, epic #2564 D-1). A held run draws the interactive
                  confirm/adjust/skip row at the run-start position, before any
                  work; a decided hold draws the read-only summary; an unheld run
                  draws nothing at all.

                  THIS SCREEN IS A HOST because a HELD run is `pending_input`, and
                  the panel that carries the card below (`AgenticRunPanel`, via
                  `SetupCompletionWatcher`) renders only for
                  `status !== "pending_input"`. Without this mount the hold would
                  be invisible on the very page the human is asked to decide it
                  on. On the branch where that panel DOES render it declares
                  `run_card` and draws the card itself, so this mount stands down
                  — see `screenHostsRecommendationCard`.

                  `wireRef` is NULL: this server-rendered mount has no run stream
                  of its own. It costs nothing here — the card resolves on mount,
                  on focus and when its own decision lands, the hold is already
                  parked before this page is served, and the confirm/skip taken IN
                  the row is the only transition out of it (which also fires
                  `router.refresh()`, re-rendering this tree). */}
              {recommendationCardNode}
              {/* §VII's audit card (cinatra#2789, S9e) — the run page's own
                  reading of what the post-change analysis found, drawn by the
                  SAME component the chat transcript and the review page mount.
                  One per verification record this run carries; none at all when
                  it carries none, and none for a reader the resolver answers
                  `absent`. */}
              {verificationCardRefs.length > 0 ? (
                <LifecycleCardSurfaceProvider host="run_card">
                  {verificationCardRefs.map((entry) => (
                    <VerificationSummaryCard
                      key={entry.reviewTaskId}
                      view={{
                        viewType: "verification_summary",
                        schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
                        ref: entry.ref,
                      }}
                    />
                  ))}
                </LifecycleCardSurfaceProvider>
              ) : null}
              {/* THE SCHEDULING STEP, ON THE RUN PAGE ITSELF (cinatra#2952).

                  A run on `pending_trigger` has finished setup and owes the
                  trigger step. It used to be served the settled setup card
                  instead, whose only control re-submitted an approval the
                  server refuses — a dead end with no trigger row at its end.
                  The standard scheduling step is drawn here instead, and it is
                  the SAME component the /trigger route mounts, so there is one
                  scheduling step in the product rather than two.

                  Agents Lifecycle (A) §7, kept in force: the step opens to the
                  RIGHT of the steps (the page-level rail is beside it, see
                  `screenHostsStepRail`), and NO agentic run progress card is
                  shown with it — a run that has not executed has no progress to
                  show. It declares its own body role: a single column of form
                  controls is Narrow (Agents §III). */}
              {runDetailPanel === "trigger" ? (
                <AgentPanelBody role="narrow">
                  <TriggerScreenClient
                    agentId={agentId}
                    instanceId={instanceId}
                    templateId={template.id}
                    isAdmin={isAdmin}
                    runId={run?.id ?? null}
                    canRespondInWindow={canRespondInWindow}
                    inputParams={inputParams}
                    requiredFields={required}
                    properties={properties}
                    setupComplete={setupComplete}
                    durationEstimate={triggerStepDurationEstimate}
                    // The declared step count, for the Estimated run duration
                    // line of a run with no history (cinatra#3224).
                    declaredStepCount={policySteps.length}
                    // WHAT THE ROW STATES, FOR THE RUNNER'S SCHEDULE DEFAULT
                    // (cinatra#2936). The step opens on the row that decision
                    // names, and presence is one of its two inputs. The reading
                    // itself is `schedulePresenceForRun` above.
                    humanPresent={schedulePresenceForRun(run)}
                  />
                </AgentPanelBody>
              ) : null}
              {/* Render setup INTERRUPT events inline on the Setup tab.
                  Only rendered once the run has been triggered (status !== pending_input),
                  and never on the scheduling step above. */}
              {/* The live page follows the run into that step (cinatra#2952).
                  The panel below is a client component that stays mounted while
                  the run leaves `pending_approval`, and `pending_trigger` is not
                  an AG-UI event, so without this the person who just answered
                  the setup gate goes on looking at the settled setup card. Only
                  where it is needed: the setup branch of a run that owes its
                  trigger step. The `agentic` branch already carries this through
                  `SetupCompletionWatcher`. */}
              {runDetailPanel === "stepper" ? (
                <TriggerStepWatcher
                  runId={run.id}
                  enabled={runMayReachTriggerStep({
                    runStatus: run.status,
                    hasTriggerRow: trigger !== null,
                    isChildRun: run.parentRunId != null,
                  })}
                />
              ) : null}
              {runDetailPanel !== "none" && runDetailPanel !== "trigger" && (
                runDetailPanel === "stepper" ? (
                  <OrchestratorStepperPanel
                    runId={run.id}
                    canRespondInWindow={canRespondInWindow}
                    initialStatus={run.status}
                    initialError={run.error ?? null}
                    agUiEnabled={run.agUiEnabled ?? null}
                    agentPackageName={template.packageName ?? undefined}
                    inputParams={(run.inputParams ?? undefined) as Record<string, unknown> | undefined}
                    stepperSteps={stepperSteps}
                    agentId={agentId}
                    lgThreadId={run.lgThreadId}
                    templateId={template.id}
                    templateName={template.name}
                    submissionMap={submissionMap}
                    initialReviewGate={initialReviewGate}
                    policySteps={policySteps as ReadonlyArray<{ stepNumber: number; gateCount?: number; hitlOwnedBy?: string; xRenderer?: string; firesRendererGate?: boolean }>}
                    // cinatra#2739: this panel's column is THE step rail on this
                    // branch, so the merged rail's trailing rows — review gates,
                    // verifications, lifecycle decisions — ride down into it
                    // instead of being drawn by a second column beside it.
                    railExtras={railExtras}
                    reviewHrefBase={reviewHrefBase}
                    inputStepInRail={inputStepIsOpen}
                  />
                ) : (
                  <SetupCompletionWatcher
                    runId={run.id}
                    agentId={agentId}
                    instanceId={instanceId}
                    // cinatra#2933 (lifecycle-b W5b) -- the run page is one of
                    // the five windows, and this watcher is the panel it is
                    // drawn by. Both halves travel together: the template the
                    // window's turns are addressed to, and the answer this
                    // page already resolved once from the RUN's own access, so
                    // the box appears for a person the run would answer and for
                    // nobody else. Same two values the other four windows on
                    // this page are given.
                    templateId={template.id}
                    canRespondInWindow={canRespondInWindow}
                    initialStatus={run.status}
                    initialError={run.error ?? null}
                    initialMessages={serializeRunMessages(completedRunMessages)}
                    agUiEnabled={run.agUiEnabled}
                    agentPackageName={agentId}
                    traceId={run.traceId ?? undefined}
                    requiredFields={required}
                    initialInputParams={(run.inputParams ?? {}) as Record<string, unknown>}
                    noRedirect={template.type === "orchestrator" || template.type === "flow" || !!run.parentRunId}
                    runHasExecuted={runHasExecuted}
                    // cinatra#2482: the trigger step is already done for this
                    // run, so the watcher must stop bouncing the run view back
                    // to /trigger. That bounce is the immediate-trigger loop:
                    // Continue persists the `immediate` row and routes here,
                    // and the watcher sent the user straight back.
                    triggerConfigured={trigger !== null}
                    initialStreamedText={run.streamedText ?? ""}
                    initialHitlContext={initialHitlContext}
                    initialReviewGate={initialReviewGate}
                    inputStepInRail={inputStepIsOpen}
                  />
                )
              )}
                </>
              );
              // THE GATE STEPS THAT HEAD THE RAIL, in the order the plan puts
              // them: the recommendation at the trigger position (plan (A) §6.2
              // — "the top entry on the step rail, ahead of the work steps it
              // would authorize"), then the schedule "above '1 Review'" (§7.2
              // step 5). Built before the rail below, because the rail renumbers
              // around however many there are.
              const railSteps: RunSurfaceRailStep[] = [];
              // AND THE RUN'S OWN INPUT FORMS AHEAD OF BOTH (cinatra#3068).
              // The input form is the first step a person meets on this page,
              // so it is the rail's first entry — one per form the agent asks,
              // in the order it asks them. Each opens the run detail beside it,
              // where the panel draws the form itself; a form the run has not
              // reached yet is drawn muted and opens nothing.
              if (inputStepsInRail) {
                railSteps.push(...buildRunInputRailSteps(runInputSteps, detailNode));
              }
              if (hasRecommendationStep) {
                railSteps.push({
                  key: "recommendation",
                  row: (
                    <RecommendationRailStepRow
                      displayStep={railSteps.length + 1}
                      settled={recommendationEntry === "settled"}
                    />
                  ),
                  // THE SAME MOUNT the run detail draws below — not a second
                  // one. Only one of the two slots is ever rendered, so the chip
                  // row the step opens is the chip row this screen hosts. It is
                  // handed over BARE: the card is the whole surface of this step
                  // (§V — "the row is the whole card"), and a wrapper would be a
                  // new anchor on a surface whose closed set is ratified.
                  //
                  // It is NULL on the branch whose panel draws the card —
                  // there `recommendationCardNode` is null because this screen
                  // mounts no card at all — so that step opens nothing, the run
                  // detail stays as this screen composed it, and the decided
                  // summary the row stands for is the one already in that panel
                  // (`RunSurfaceRailStep.surface`). On every other branch this
                  // IS the surface, settled or live alike.
                  surface: recommendationCardNode,
                });
              }
              if (scheduleRailRef) {
                railSteps.push({
                  key: "schedule",
                  row: (
                    <ScheduleRailStepRow host="run_card" displayStep={railSteps.length + 1} />
                  ),
                  // AND THE PROMPT WINDOW UNDER THE SCHEDULER (cinatra#2972)
                  // — "The run page's prompt window shows below the scheduler"
                  // (plan (A) §7.2, amended 2026-08-25). The review page passes
                  // none: the plan names the run page.
                  surface: (
                    <ScheduleStepSurface
                      host="run_card"
                      cardRef={scheduleRailRef}
                      promptWindowTemplateId={template.id}
                      // cinatra#2933 -- the window under this scheduler is the
                      // RUN's conversation, gated on the run's own access.
                      runId={run?.id ?? null}
                      canRespondInWindow={canRespondInWindow}
                    />
                  ),
                });
              }
              // THE STEPS STILL TO COME (cinatra#3068 fix leg 2). The
              // ratified drawing puts the run's later steps BELOW the
              // highlighted one -- "so the rail is the run's whole lifecycle at
              // a glance, not just its live tip" -- and the graded picture of
              // the input moment drew ONE row with nothing beneath it. These
              // are the setup flow's own three steps, the same three the
              // schedule screen's rail names, drawn as steps the run has NOT
              // reached: muted, opening nothing, because the plan draws no "not
              // reached yet" screen and none is invented for them.
              //
              // FOR AS LONG AS THE RAIL CARRIES THE RUN'S INPUT STEPS (fix
              // leg 3), which includes the ANSWERED form the drawing keeps --
              // "its entry keeps its place ... steps already passed sit above
              // it, steps still to come below". Leg 2 drew them only while the
              // form was open, so answering it collapsed four rows to one. They
              // stop where the run's own history starts, and never draw twice:
              // both answers are `railDrawsUpcomingRunSteps` and
              // `upcomingRunRailStepKeys` above.
              const upcomingRailStepKeys = upcomingRunRailStepKeys({
                drawUpcoming: railDrawsUpcomingRunSteps({
                  inputStepIsOpen,
                  inputStepsInRail,
                  hasExecution: runHasExecution,
                }),
                drawnKeys: railSteps.map((step) => step.key),
              });
              if (upcomingRailStepKeys.length > 0) {
                railSteps.push(
                  ...buildSetupRailSteps(
                    upcomingRailStepKeys.map((key) => ({
                      key,
                      reached: false,
                      settled: false,
                      surface: null,
                    })),
                    railSteps.length,
                  ),
                );
              }
              // The page's OWN rail rows. The gate rows above are drawn by
              // their own step components rather than by this rail, because the
              // live orchestrator column is the rail on the flow branch
              // (`screenHostsStepRail`) and the plan puts both gate steps above
              // the run's steps on every branch — not only the one where the
              // server-rendered rail happens to draw.
              const railDraws = screenDrawsPageRail({
                runStatus: run.status,
                railEntryCount: rail.entries.length,
                gateStepCount: railSteps.length,
                panel: runDetailPanel,
                stepperStepCount: stepperSteps.length,
              });
              const railNode = railDraws ? (
                <RunStepRailPanel
                  entries={rail.entries}
                  activeOrdinal={rail.activeOrdinal}
                  reviewHrefBase={reviewHrefBase}
                  stepOffset={railSteps.length}
                />
              ) : null;
              // THE TWO COLUMNS. With a gate step, the frame owns them: the
              // steps head the rail and they open ON THE RIGHT, in the run
              // detail, never under their own row (plan (A) §6.2 and §7.2 step 5,
              // and the ratified drawing `design-run-surface-rail-and-gate.png`
              // — "a gate step opens the gate's own surface in place … right here
              // in the run detail, under the same rail"). Without one, the
              // surface is what it always was.
              if (railSteps.length > 0) {
                return (
                  <RunSurfaceRail
                    steps={railSteps}
                    rail={railNode}
                    detail={detailNode}
                    initialSelection={initialStep}
                  />
                );
              }
              return (
                <>
                  {railNode ? (
                    <div className="flex shrink-0 flex-col gap-2 pt-1">{railNode}</div>
                  ) : null}
                  <div className="flex min-w-0 flex-1 flex-col gap-4">{detailNode}</div>
                </>
              );
            })()}
          </div>
          </AgentPanelBody>
        ) : (
          // An empty-state notice is neither a form nor a control stack, so it
          // takes the frame width (Application Design — Agents §III).
          <AgentPanelBody role="frame">
            <div className="soft-panel rounded-card p-6">
              <p className="text-sm text-muted-foreground">No run selected.</p>
            </div>
          </AgentPanelBody>
        )}
      </AgentPageLayout>
    </Main>
  );
}

// cinatra#2066 C1 / AC-4: `RunScreen` (the old `instanceRun` mapping) was the
// transcript-only run screen with NO consuming route. The canonical run view is
// now `SetupScreen` above — ONE run-detail contract with the left step rail for
// BOTH template classes — so this dead screen and its dead mapping are removed
// (see agentPluginScreens in screens.tsx).

export async function PermissionsScreen({ agentId, instanceId }: ScreenProps) {
  const template = await resolveTemplateForActor(agentId);
  if (!template) notFound();
  const extensionHeaderLink = buildExtensionHeaderLink(
    template.packageName,
    isPlatformAdmin(await getAuthSession().catch(() => null)),
  );

  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;
  // Comma-split admin parser.
  const isAdmin = isPlatformAdmin(session);

  // Defense-in-depth org check. resolveTemplateForActor only
  // filters by actorUserId — a template owned by another org but published
  // would still be reachable here. When the template carries an orgId and
  // the session has an activeOrganizationId, require they match (admins
  // override).
  const activeOrgId = session?.session?.activeOrganizationId ?? null;
  if (
    !isAdmin &&
    template.orgId &&
    activeOrgId &&
    template.orgId !== activeOrgId
  ) {
    notFound();
  }

  // Empty state when no specific run is selected. The Permissions tab is
  // per-run; no template-level default policy is rendered here.
  if (!instanceId || instanceId === "new") {
    return (
      <Main className="min-h-screen">
        <AgentPageLayout
          agentId={agentId}
          instanceId={instanceId}
          activeTab="permissions"
          templateName={template.name}
          initialRunName=""
          runId={null}
          isPublished={template.status === "published"}
          extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
          extensionHref={extensionHeaderLink?.extensionHref}
        >
          <AgentPanelBody role="frame">
            <div className="soft-panel rounded-card p-6 flex flex-col gap-2">
              <h2 className="text-base font-semibold text-foreground">
                No run selected
              </h2>
              <p className="text-sm text-muted-foreground">
                Start a run to view or configure its access policy.
              </p>
            </div>
          </AgentPanelBody>
        </AgentPageLayout>
      </Main>
    );
  }

  // Pass actor + roles so readAgentRunById enforces effectivePolicy
  // (runDataVisibility). Access denial is surfaced as AuthzError and mapped to
  // notFound() below.
  const permActor: PrimitiveActorContext = { actorType: "human", source: "ui", userId: actorUserId ?? undefined };
  const permRoles: ActorRoleHints = {
    platformRole: isAdmin ? "platform_admin" : "member",
    // admin-parity P4 (cinatra#1129): thread the actor's active-org role so the
    // owner-aware run "admin" visibility tier recognizes an org admin/owner.
    orgRole: session
      ? await resolveOrgRoleForSession({ user: { id: session.user.id }, session: session.session })
      : undefined,
    actorOrganizationId: session?.session?.activeOrganizationId ?? undefined,
  };
  let run: Awaited<ReturnType<typeof readAgentRunById>>;
  try {
    run = await readAgentRunById(instanceId, permActor, permRoles);
    if (!run) notFound();
  } catch (err) {
    if (err instanceof AuthzError) notFound();
    throw err;
  }

  // Resolve co-owner status for canEdit check below (readAgentRunById already
  // loaded co-owners internally for enforcement; re-read here for the UI flag).
  const isOwner = Boolean(run.runBy && run.runBy === actorUserId);
  let isCoOwner = false;
  if (!isOwner && !isAdmin && actorUserId) {
    const coOwnerRows = await readRunCoOwners(run.id);
    isCoOwner = coOwnerRows.some((c) => c.userId === actorUserId);
  }

  const effectivePolicy = resolveEffectivePolicy(run, template);
  const source: "template-default" | "run-override" =
    run.authPolicy !== null ? "run-override" : "template-default";
  // Co-owners have full equal rights to the original owner.
  const canEdit = Boolean(
    actorUserId && (isOwner || isCoOwner || isAdmin),
  );

  // ScopeReason: compute the inline explanation for why
  // the actor can see this run. Owners see null (no reason shown — they own it).
  // currentUserId is used here to determine ownership; it is also forwarded to
  // PermissionsTabClient for the RunSharingPanel.
  const isOwnerView = run.runBy === actorUserId;

  // -------------------------------------------------------------------------
  // Resolve availableScopes for the hierarchical Select. The client never
  // queries Better Auth tables; all directory data is server-resolved and
  // passed as props.
  //
  // Multi-org: readOrgsWithTeamsForUserActiveOnly returns every active
  // (non-archived) org the actor belongs to, with their teams nested — a UI
  // scope picker, so archived orgs are excluded (cinatra#1942 archive V1,
  // Decision 4).
  // -------------------------------------------------------------------------

  const orgs = actorUserId
    ? await readOrgsWithTeamsForUserActiveOnly(actorUserId)
    : [];

  const activeOrgIdForScopes =
    session?.session?.activeOrganizationId ?? null;

  const projects =
    actorUserId && activeOrgIdForScopes
      ? await readProjectsForUser(actorUserId, activeOrgIdForScopes)
      : [];

  // Widen the workspace UI gate to match the kernel rule
  // `platform_admin || org_admin || org_owner` (auth-policy.ts:465).
  // The server still enforces authoritatively via AgentAuthPolicySchema +
  // policyAllows; this keeps UX permission availability aligned with server
  // enforcement.
  const orgRole =
    session?.user?.id
      ? await resolveOrgRoleForSession({ user: { id: session.user.id }, session: session.session })
      : undefined;
  const canGrantWorkspace =
    isAdmin ||
    orgRole === "org_owner" ||
    orgRole === "org_admin";

  const availableScopes: AvailableScopes = {
    orgs,
    projects,
    canGrantWorkspace,
  };

  // Containment (cinatra#1607 §6.4): narrow the agent_run permissions form to
  // scopes within the parent agent_template's policy via the picker's FIRST-CLASS
  // `allowedScopes` prop — not a per-site data pre-filter. `AccessCombobox` runs
  // the same §VI containment algebra as every other picker; this replaces the old
  // `filterAvailableScopesForParentPolicy` data narrowing (which is now the
  // internal, equivalence-proven core of `allowedScopeIdentitiesFromPolicy`).
  // The result is a serializable typed `{ kind, id }[]` — a predicate cannot
  // cross the Server → Client boundary, an identity list can. Authoritative
  // rejection still lives server-side in `saveExtensionAccessPolicy`
  // (assertAgentRunPolicyContainedByTemplate); this is DISPLAY input only (§6.8).
  // Read-side policy resolution stays unchanged — grandfathered runs remain
  // readable.
  const { allowedScopeIdentitiesFromPolicy } = await import("@cinatra-ai/extensions/scope-containment-filter");
  const runScopeAllowedScopes = allowedScopeIdentitiesFromPolicy(
    availableScopes,
    template.agentAuthPolicy ?? {
      runListVisibility: ["owner"],
      runDataVisibility: ["owner"],
      runExecuteVisibility: ["owner"],
      allowRunSharing: false,
    },
    template.orgId ?? null,
  );

  // -------------------------------------------------------------------------
  // Resolve coOwners. Read run_co_owners then enrich with
  // Better Auth user display info via a single inArray batch.
  // -------------------------------------------------------------------------
  const coOwnerRows = await readRunCoOwners(run.id);
  const coOwnerUserIds = coOwnerRows.map((r) => r.userId);

  const allOwnerIds = [
    ...(run.runBy ? [run.runBy] : []),
    ...coOwnerUserIds,
  ];

  let coOwners: CoOwnerView[] = [];
  let runOwner: CoOwnerView | null = null;
  if (allOwnerIds.length > 0) {
    const userRows = await betterAuthDb
      .select({
        id: betterAuthUsers.id,
        name: betterAuthUsers.name,
        email: betterAuthUsers.email,
        image: betterAuthUsers.image,
      })
      .from(betterAuthUsers)
      .where(inArray(betterAuthUsers.id, allOwnerIds));

    const byId = new Map(userRows.map((u) => [u.id, u]));

    if (run.runBy) {
      const u = byId.get(run.runBy);
      runOwner = {
        userId: run.runBy,
        name: u?.name ?? u?.email ?? "Unknown",
        email: u?.email ?? "",
        image: u?.image ?? null,
      };
    }

    coOwners = coOwnerRows.map((row) => {
      const u = byId.get(row.userId);
      return {
        userId: row.userId,
        name: u?.name ?? u?.email ?? "Unknown",
        email: u?.email ?? "",
        image: u?.image ?? null,
      };
    });
  }

  // Derive scope reason for non-owner viewers. Source org/team names from
  // already-resolved `orgs` (no extra round-trip).
  const activeOrgForReason =
    orgs.find((o) => o.id === (session?.session?.activeOrganizationId ?? null)) ?? orgs[0] ?? null;
  // Multi-scope W1: runListVisibility is a token array; the scope-reason banner
  // reads the first token (W3 renders the multi-scope summary).
  const visibility = effectivePolicy.runListVisibility[0];
  const teamIdInVisibility = typeof visibility === "string" && visibility.startsWith("team:")
    ? visibility.slice("team:".length)
    : null;
  const teamForReason = teamIdInVisibility
    ? activeOrgForReason?.teams.find((t) => t.id === teamIdInVisibility) ?? null
    : null;
  const scopeReason = isOwnerView
    ? null
    : buildScopeReason(visibility, {
        orgName: activeOrgForReason?.name,
        teamName: teamForReason?.name,
      });

  // cinatra#2487: the strip is part of the constant frame, so /permissions must
  // resolve the Trigger tab with the SAME predicate the other routes use —
  // previously it passed nothing, so switching Setup → Permissions dropped the
  // Trigger tab and shifted the strip and the etched rule's start point.
  const permissionsTrigger = await readRunTriggerByRunId(run.id);

  return (
    <Main className="min-h-screen">
      <AgentPageLayout
        agentId={agentId}
        instanceId={instanceId}
        activeTab="permissions"
        templateName={template.name}
        initialRunName={run.title ?? ""}
        runId={run.id}
        isPublished={template.status === "published"}
        showTriggerTab={shouldShowPersistentTab(permissionsTrigger)}
        extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
        extensionHref={extensionHeaderLink?.extensionHref}
      >
        {scopeReason && (
          <p className="text-xs text-muted-foreground">
            {scopeReason}
          </p>
        )}
        {/*
          Declared body role (Application Design — Agents §III, row
          "Permissions — the access / ownership controls"): "Narrow where the
          controls are authored as one column; FRAME WIDTH where the panel
          presents rows with per-row controls." PermissionsForm's Ownership
          section is exactly the latter — a <ul> of owner/co-owner rows each
          carrying its own remove control (permissions-form.tsx) — so this panel
          takes the frame width, which is also what it renders at today.
        */}
        <AgentPanelBody role="frame">
        <ExtensionPermissionsClient
          kind="agent_run"
          resourceId={run.id}
          canEdit={canEdit}
          initialPolicy={effectivePolicy}
          owner={runOwner}
          coOwners={coOwners}
          availableScopes={availableScopes}
          allowedScopes={runScopeAllowedScopes}
          currentUserId={actorUserId}
          allowSharing={canEdit ? true : effectivePolicy.allowRunSharing}
          removeOwner={async () => {
            "use server";
            return removeRunOwner(run.id);
          }}
        />
        </AgentPanelBody>
      </AgentPageLayout>
    </Main>
  );
}

export async function DataScreen({ agentId, instanceId }: ScreenProps) {
  const agentPath = agentId.includes("/")
    ? agentId.split("/").map(encodeURIComponent).join("/")
    : encodeURIComponent(agentId);
  redirect(`/agents/${agentPath}/${encodeURIComponent(instanceId)}`);
}

export async function TriggerScreen({ agentId, instanceId }: ScreenProps) {
  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;
  // Admin override for cross-screen consistency.
  // Hoisted ahead of the ownership check for the releaseTriggerNow
  // defense-in-depth check.
  const isAdmin = isPlatformAdmin(session);
  const template = await readAgentTemplateBySlug(agentId, {
    actorUserId,
    includeNonPublished: true,
  });
  if (!template) notFound();
  const extensionHeaderLink = buildExtensionHeaderLink(
    template.packageName,
    isPlatformAdmin(await getAuthSession().catch(() => null)),
  );

  // Pass actor + roles so readAgentRunById
  // enforces effectivePolicy (runDataVisibility). The manual co-owner gate
  // is replaced by enforceRunAccess("read") inside readAgentRunById.
  const triggerActor: PrimitiveActorContext = { actorType: "human", source: "ui", userId: actorUserId ?? undefined };
  const triggerRoles: ActorRoleHints = {
    platformRole: isAdmin ? "platform_admin" : "member",
    // admin-parity P4 (cinatra#1129): thread the actor's active-org role so the
    // owner-aware run "admin" visibility tier recognizes an org admin/owner.
    orgRole: session
      ? await resolveOrgRoleForSession({ user: { id: session.user.id }, session: session.session })
      : undefined,
    actorOrganizationId: session?.session?.activeOrganizationId ?? undefined,
  };
  let run: Awaited<ReturnType<typeof readAgentRunById>> = null;
  if (instanceId !== "new") {
    try {
      run = await readAgentRunById(instanceId, triggerActor, triggerRoles);
      if (!run) notFound();
    } catch (err) {
      if (err instanceof AuthzError) notFound();
      throw err;
    }
  }

  // cinatra#2933 — the window's own access answer for this run. `true` with no
  // run: there is nothing to ask, and the screen keeps the box it has today.
  const canRespondInWindow = run ? await canRespondInRunWindow(run.id) : true;

  const inputSchema = (template.inputSchema ?? {}) as {
    properties?: Record<string, { title?: string } & Record<string, unknown>>;
    required?: string[];
  };
  const required = inputSchema.required ?? [];
  const properties = inputSchema.properties ?? {};

  const inputParams = (run?.inputParams ?? {}) as Record<string, unknown>;
  const setupComplete = required.every((f) =>
    Object.prototype.hasOwnProperty.call(inputParams, f),
  );

  // Server-side compute of the duration estimate so the
  // client component renders the banner deterministically. The estimator
  // returns null for start-only/dynamic agents or when LLM analysis fails;
  // the client falls back to the "unavailable" copy in that case.
  const compiledOas: { triggerMode?: "full" | "start-only" } = {
    triggerMode: template.triggerMode ?? undefined,
  };
  const skillMd = (template.taskSpec ?? "") as string;
  const durationEstimate = await estimateRunDuration({
    template: { id: template.id },
    compiledOas,
    skillMd,
  });

  // Visibility rule:
  //   - row exists AND triggerType IN ('scheduled','recurring') → the schedule
  //     surface, which IS the schedule form (cinatra#3004)
  //   - otherwise → first-step form
  const trigger = run ? await readRunTriggerByRunId(run.id) : null;
  const showPersistentTab = shouldShowPersistentTab(trigger);
  // THE SURFACE IS THE FORM (cinatra#3004). The schedule this run carries is
  // drawn by the one renderer every other surface uses, addressed by the RUN —
  // the same ref the run detail's schedule step is opened on, so the two read
  // one schedule and cannot disagree about its state. A run that cannot mint a
  // ref falls back to the first-step form below, exactly as a run with no
  // schedule does.
  const scheduleTabSurface =
    runScheduleAdapterFor({ screen: "schedule_tab", trigger }) === "schedule_tab";
  const scheduleTabRef =
    run && scheduleTabSurface ? encodeScheduleRunRef({ runId: run.id }) : null;
  // A fired one-off cannot be changed (cinatra#2980, plan (A) §7.2 item 4), so
  // the standalone form below is drawn as a reading rather than as a control,
  // and the notice above it says which of the two facts hold.
  const scheduleFrozen = shouldFreezeFiredOneOffSchedule(trigger);
  const finishedNotice = finishedRunNoticeCopy({
    finished: run ? shouldShowFinishedRunNotice(trigger, run.status) : false,
    frozen: scheduleFrozen,
  });

  // Server-rendered admin role flag is hoisted to the top of TriggerScreen
  // so the ownership check can apply the admin override. Same comma-split
  // parser as `isPlatformAdmin`.
  // Defense-in-depth alongside the releaseTriggerNow server-action role
  // check.

  // NO SERVER-RENDERED SCHEDULE SUMMARY, AND NO HELD-STEPS TREE (cinatra#3004).
  // The retired drawing needed both: a cron sentence for its "Trigger
  // configuration" rows and the template's gated steps for its tree. The form
  // draws the schedule in its own option rows, read back from the installed row
  // by the resolver, so neither is computed here any more.

  // ── WHAT HAS THIS RUN GOT TO SHOW FOR THESE STEPS? (cinatra#2970) ───────
  //
  // The rail says which steps a person can open, so it must READ that off the
  // run — and the reading has to be the one the rest of the product already
  // makes, or the same run says two different things on two screens.
  //
  // WHAT WENT WRONG, PHOTOGRAPHED (cells C10 and C11 of the #2939 proof set).
  // Both rows were answered WITHOUT reading the run:
  //
  //   • the skills row closed on the pre-execution STATUS SET, which is the
  //     opposite of the question it was asked. A recommendation hold parks its
  //     run at `pending_input` — so the row was CLOSED exactly when the card had
  //     something to draw, and OPEN exactly when it had nothing. Two presses
  //     from the scheduler reached an empty run detail.
  //   • the review row was composed with no surface at all, unconditionally, so
  //     `isRunSurfaceStepSelectable` closed it for every run there has ever
  //     been. The review step could not be opened on this screen.
  //
  // BOTH ARE THE RUN'S OWN ROWS NOW, through the readers that already own those
  // questions — no third derivation, and nothing inferred from a status.
  //
  // THE SKILLS STEP: `recommendationRailEntry` (cinatra#2790), the same
  // predicate the run page's rail asks. A run with a LIVE hold opens the card; a
  // run whose hold was DECIDED opens the settled reading the same one renderer
  // draws ("a resolved gate stays on the rail as read-only history — its entry
  // keeps its place and records how it was settled"); a run that never held has
  // no entry, and its row is closed and muted.
  //
  // READING THE PARK IS THE RAIL'S, NOT THE CARD'S. cinatra#2573 makes the card
  // the one authority on the INTERACTION, and nothing here draws or decides it:
  // this asks only whether the run ever held, which is what decides that the row
  // exists at all. That is exactly the read the run page's own rail makes
  // (`recommendation-rail-entry.ts`), and it is a plain run-scoped read behind
  // the access door `readAgentRunById` cleared above.
  const recommendationPark = run ? await readRecommendationParkForRun(run.id) : null;
  const recommendationEntry = recommendationRailEntry({
    hasPark: recommendationPark !== null,
    held: recommendationPark?.status === "parked",
    // THIS screen hosts the card here. The setup surface draws no run-detail
    // panel at all — the run has not run — so there is no other module that
    // could mount it, and the step's surface is this screen's own mount.
    hostsCard: true,
  });
  // AND CAN IT BE OPENED? A terminal park is not the same as a DECIDED one: the
  // TTL sweeper's fail-closed `policy_unresolved` leaves a park behind that
  // nobody answered, and the card draws nothing for it. This page has no run
  // detail to fall back to, so such a row is closed and muted rather than
  // openable over an empty column.
  const recommendationStepOpens = recommendationRailStepOpens({
    entry: recommendationEntry,
    parkStatus: recommendationPark?.status,
  });
  // AND HOW DOES THE ROW READ once the question has been answered
  // (cinatra#2975)? The ratified drawing: "A resolved gate stays on the rail as
  // read-only history — its entry keeps its place and records how it was
  // settled." The run page's own recommendation row has drawn that since
  // cinatra#2790 — the completed circle in place of the numeral — and this
  // page's rows did not, so a run came back from its own Confirm still numbered.
  //
  // A TERMINAL PARK IS NOT A DECIDED ONE, here for the reason it is not above:
  // `policy_unresolved` reads as `settled` for the ENTRY — the row keeps its
  // place — and nobody answered it, so there is nothing for a completed circle
  // to record. That is the same read `recommendationRailStepOpens` just made
  // (for a settled entry it IS `status === "released"`), so it is asked once
  // rather than derived a second time from the park.
  const recommendationSettled =
    recommendationEntry === "settled" && recommendationStepOpens;
  //
  // THE REVIEW STEP: `readRunReviewSlot` (cinatra#2997), the same reader the run
  // page's panel asks, and `runReviewStepReading` for the step from its two
  // facts to the three readings. A run reaches this screen with a review on file
  // more often than it looks — a finished immediate run being given a recurring
  // schedule is exactly that — and a run parked on its own review gate is
  // another.
  const runReviewSlot = run ? await readRunReviewSlot(run.id) : null;
  const reviewStepReading = runReviewStepReading(runReviewSlot);
  // AND WAS THAT GATE ANSWERED? The rail's history reading again — plan (A) §4.2
  // keeps a decided review "on the run's audit trail and on the rail as
  // read-only history". The slot names WHICH gate is the run's; the gate's own
  // row says whether it was answered, which is the same shape the recommendation
  // row above reads its park's status in. Read only where the slot named a gate,
  // and behind the same access door `readAgentRunById` already cleared: it is a
  // plain run-scoped read, and only the row's status is taken from it — the
  // decision's evidence belongs to the card (cinatra#2573).
  //
  // AND ONLY THE BRANCH THAT DRAWS THE RAIL PAYS FOR IT — the same discipline
  // `triggerStepDurationEstimate` follows on the run page (cinatra#2952), where
  // a computation is made on the branch that draws it and nowhere else. Since
  // cinatra#3004 that branch is EVERY run on this route: arming a schedule no
  // longer hands the screen to a second drawing of the same facts, it fills
  // this rail's schedule step, so the only screen here with no rail at all is
  // `/trigger` reached with `new` — which has no run to read a row off in the
  // first place, and the `run` guard already answers that.
  const reviewGate =
    run && runReviewSlot?.reviewTaskId
      ? await readReviewGate(run.id, runReviewSlot.reviewTaskId)
      : null;
  const reviewStepSettled = runReviewStepSettled({
    reading: reviewStepReading,
    gateStatus: reviewGate?.status,
  });

  // ── THE SCHEDULE STEP'S OWN SURFACE (cinatra#2970, cinatra#3004) ─────────
  //
  // TWO READINGS OF ONE STEP, and which one it draws is decided by the schedule
  // the run actually carries:
  //
  //   • NO SCHEDULE YET — the scheduling form exactly as it is today, in its
  //     first-shown state, with the same Continue that arms the trigger. Not
  //     one prop of it changes here; what changes is only WHERE it is drawn —
  //     one step of the run surface below, opened in the run detail beside the
  //     rail, instead of standing alone in the middle of a single-column page.
  //
  //   • A SCHEDULE ON FILE — that schedule, drawn by the one renderer every
  //     other surface uses (cinatra#3004): "The schedule surface on the agent's
  //     page shows the schedule form itself in its respective state — never a
  //     'Trigger configuration' card — the same form as in the chat and on the
  //     run page."
  //
  // AND THE PRESS THAT ARMS ONE STAYS IN THIS STEP (cinatra#3004). Continue on
  // a scheduled or recurring kind navigates nowhere — it re-renders this route
  // — so the run comes straight back to this step with its armed schedule in
  // it. What happened before was that the whole screen was handed to a second
  // drawing of the same facts, and the rail the reader pressed from went with
  // it.
  //
  // Both readings keep the declared body role: a single column of form controls
  // is Narrow (Application Design — Agents §III), and Narrow is an inset that
  // sits inside whatever frame holds it.
  const scheduleFormSurface = (
    <AgentPanelBody role="narrow">
      {/*
        CONTEXT ABOVE THE FORM (cinatra#2482), and since cinatra#2980 the
        truth about what the form can still do.

        The reported repro ends on this screen with no idea that the run is
        over, so the state has to be said out loud. The earlier cut said it
        and then promised a route it also kept open — "you can still give it
        a recurring schedule below" — on a run whose own one-off schedule had
        already fired. Plan (A) §7.2 item 4: "once a one-off has fired it
        cannot be changed". `setRunTriggerForActor` refuses it, so the screen
        stops offering it: the copy names the action that works instead, and
        the form is mounted as a reading.
      */}
      {finishedNotice ? (
        <div
          className="soft-panel rounded-card mb-4 flex flex-col items-start gap-2 p-4"
          data-run-finished-notice=""
        >
          <h2 className="text-sm font-semibold text-foreground">
            {finishedNotice.heading}
          </h2>
          <p className="text-sm text-muted-foreground">{finishedNotice.body}</p>
          <Link
            href={`/agents/${agentId}/${encodeURIComponent(instanceId)}`}
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            data-action="open-finished-run"
          >
            View this run
          </Link>
        </div>
      ) : null}
      {/*
        THE SAME FORM, AS A READING (cinatra#2980).
        design@fe2182547d4a `specs/app-components.html` § "Standard
        scheduling step", the "Configured schedule step" reading: "Once a
        *Run right after setup* or *Schedule for later* schedule has fired it
        cannot be changed any more: the form stays as a **read-only** reading
        with no controls at all." The form is not hidden — it is the reading
        of the schedule this run had — and it carries nothing to press.

        AND IT NEVER OFFERS TO ARM A SCHEDULE THIS RUN ALREADY HAS
        (cinatra#3004). This reading is also where a run whose schedule could
        not mint a card ref lands. That run HAS a schedule — the step's other
        reading would have drawn it — so the first-step form is drawn as a
        reading here too. Offering Continue would let a person replace a
        schedule they cannot currently see.
      */}
      <TriggerScreenClient
        agentId={agentId}
        instanceId={instanceId}
        templateId={template.id}
        isAdmin={isAdmin}
        runId={run?.id ?? null}
        canRespondInWindow={canRespondInWindow}
        inputParams={inputParams}
        requiredFields={required}
        properties={properties}
        setupComplete={setupComplete}
        durationEstimate={durationEstimate}
        declaredStepCount={template.approvalPolicy?.steps?.length ?? 0}
        readOnly={scheduleFrozen || scheduleTabSurface}
      />
    </AgentPanelBody>
  );

  // THE SCHEDULE THIS RUN CARRIES, in the state it is in (cinatra#3004). The
  // one renderer, addressed by the RUN — the same ref the run detail's schedule
  // step is opened on, so the two surfaces read one schedule and cannot
  // disagree about its state. `runScheduleAdapterFor` above is what picked it,
  // and it picks exactly one adapter per screen: this step is the schedule tab's
  // adapter, and the run detail's rail step is the other.
  const scheduleStepSurface = scheduleTabRef ? (
    <AgentPanelBody role="narrow">
      <RunScheduleTab
        cardRef={scheduleTabRef}
        promptWindowTemplateId={template.id}
        // cinatra#2933 (lifecycle-b W5b) -- this step's window is one of the
        // five, so it is the RUN's conversation and it is gated on the run's
        // own access, exactly like the other four. The schedule's own state
        // still decides whether there is a form to edit at all: the composer
        // is withdrawn once the schedule is over (cinatra#3004), which this
        // component measures off the card and is unchanged.
        //
        // Read optionally rather than asserted: `scheduleTabRef` is minted
        // only for a run, so this reading always has one, but that is a fact
        // about the ref's derivation that the compiler cannot see -- and the
        // window's own rule for a host with no run is already "no run, nothing
        // to hold a conversation about".
        runId={run?.id ?? null}
        canRespondInWindow={canRespondInWindow}
      />
    </AgentPanelBody>
  ) : (
    scheduleFormSurface
  );

  // ── THE REVIEW STEP'S OWN SURFACE (cinatra#2970; plan (A) §4.2) ──────────
  //
  // The maintainer's words for this slot, which the run page's panel already
  // draws and which this step now draws the same way: the card is "a temporary
  // placeholder for the review screen" while the agent works, and "once the
  // agent is done and the output generated" it "is being automatically replaced
  // with the 'Review requested' screen".
  //
  // ONE BOX, TWO READINGS, and the box says which it is drawing
  // (`data-run-review-slot`) — the swap is the ruled property, so a proof has to
  // be able to see the placeholder go and the review screen arrive in the same
  // slot. The card is the SHIPPED `ReviewGateCard`, addressed by a server-minted
  // ref over (runId, reviewTaskId) exactly as the run page's own seed is, and it
  // re-authorizes itself against that ref.
  //
  // WHAT THIS DOES NOT CLOSE, said rather than left to be found: the card draws
  // nothing at all for a reader its own resolve refuses, so the slot box can be
  // drawn around nothing. The box is still there — the column is never blank —
  // and closing the gap needs the card's resolved state, which belongs to the
  // card. It is the same residual the run page's panel carries.
  const reviewStepSurface = (() => {
    if (!run || reviewStepReading === "none") return null;
    // The gate's ref is minted HERE, from the run and the gate the slot named —
    // never taken from a client, and never invented for a run that has no gate.
    const gateRef = runReviewSlot?.reviewTaskId
      ? encodeLifecycleGateRef({
          runId: run.id,
          reviewTaskId: runReviewSlot.reviewTaskId,
        })
      : null;
    return (
      <section
        className="soft-panel rounded-card px-6 py-5 flex flex-col gap-4"
        data-run-review-slot={gateRef ? "review" : "working"}
      >
        {gateRef ? (
          <LifecycleCardSurfaceProvider host="run_card">
            <ReviewGateCard
              view={{
                viewType: "artifact_review_gate",
                schemaVersion: LIFECYCLE_VIEW_SCHEMA_VERSION,
                ref: gateRef,
              }}
              // §VI — the gate's conversational prompt window keeps its exchange
              // with the RUN (cinatra#3141 item 1), so the mount that names the
              // gate names the run it opened on too.
              runId={run.id}
            />
          </LifecycleCardSurfaceProvider>
        ) : (
          <ReviewGatePlaceholder />
        )}
      </section>
    );
  })();

  // ── THE SETUP RUN PAGE'S STEP RAIL (cinatra#2970, epic #2784) ────────────
  //
  // The setup run page shows the series of steps that set the run up — the
  // scheduler among them, and the skills recommendation and the review beside
  // it (cinatra#2970). The ratified drawing
  // `design-run-surface-rail-and-gate.png` draws EVERY run-page state as the
  // same two-column frame — "a step rail down the left names the run's ordered
  // steps, and the run detail on the right shows the selected step" — and the
  // setup flow was the one run-page screen that drew a single centred column
  // instead.
  //
  // THE THREE STEPS ARE THE SETUP FLOW'S OWN, and no fourth is invented: the
  // schedule (plan (A) §7), the skills recommendation (§6) and the review (§4).
  // Each keeps EXACTLY the surface it has today — the scheduling form, and the
  // one shipped renderer of the recommendation card. A step the run has not
  // reached draws nothing: the plan draws no "not reached yet" screen, so none
  // is invented for it, and the run detail simply has nothing in it until the
  // step is reached.
  //
  // AND NO RUN PROGRESS IS DRAWN BESIDE ANY OF THEM. This page is served for a
  // run that has not executed, so there is no progress to show — plan (A) §7.2
  // step 5 for the schedule step, §6.2 for the recommendation step.
  // The steps THEMSELVES, before their rows: the row a step gets depends on
  // whether it can be opened, and that is the frame's own predicate rather than
  // a second rule written here (`setup-run-surface-steps.tsx`).
  const setupSteps: SetupRailStep[] = run
    ? [
        {
          key: "schedule",
          // AND NO SETTLED READING FOR THIS ONE (cinatra#2975), which is a
          // finding rather than an omission. The drawing's history row is a
          // resolved GATE's, and a schedule is not a gate: plan (A) §7.2 step 5
          // opens this step "to see the configuration or change it", and draws
          // the line itself — "a trigger decides *when* the agent runs, and a
          // review card exists only after the agent has run". Nor is a fired
          // schedule finished: §7.2 keeps a recurring one editable after it
          // fires, and puts the fired one-off's read-only reading in the FORM —
          // "the form stays as a read-only reading with no controls at all",
          // which the step's own surface above already draws. The run page's
          // schedule row draws no settled reading either, and inventing one here
          // would make the same step read two ways on two screens.
          surface: scheduleStepSurface,
        },
        {
          key: "recommendation",
          // HAS THIS RUN GOT A RECOMMENDATION AT ALL? A live hold opens the
          // card, a decided one opens the settled reading the same renderer
          // draws, and a run that never held has nothing for this step — so its
          // row is closed and muted rather than opening an empty column.
          reached: recommendationStepOpens,
          // AND ONCE IT IS ANSWERED the row is the rail's read-only history row:
          // the completed circle in place of the numeral, the title
          // unhighlighted. The row keeps its place either way.
          settled: recommendationSettled,
          // The ONE renderer of this interaction (cinatra#2573), on the host
          // this screen declares. It is handed over only where the run has a
          // recommendation the card will actually draw: an element of a card
          // that resolves to nothing is still an element, so a rail handed one
          // unconditionally cannot tell that the column will come up blank —
          // which is what shipped.
          surface: !recommendationStepOpens ? null : (
              <LifecycleCardSurfaceProvider host="run_card">
                <RecommendationHoldCard
                  runId={run.id}
                  agentPackageName={template.packageName ?? ""}
                  wireRef={null}
                />
              </LifecycleCardSurfaceProvider>
            ),
        },
        {
          key: "review",
          // The run's own review slot, read by the same reader the run page's
          // panel reads it with. A run with nothing to review has nothing for
          // this step, and its row is closed and muted — the plan draws no "no
          // review yet" screen and none is invented here.
          reached: reviewStepReading !== "none",
          // A DECIDED gate is history on the rail the same way, and what its row
          // opens is unchanged: the card draws its own settled reading from its
          // own state ladder.
          settled: reviewStepSettled,
          surface: reviewStepSurface,
        },
      ]
    : [];

  // AND THEIR ROWS. The shared run-surface row (cinatra#2970): the numeral, the
  // word, and the closed treatment for a step that has nothing to open. The
  // schedule and recommendation steps on the RUN page draw their own rows
  // instead, because those carry anchors of their own; these three carry none.
  //
  // ── THE RUN'S ANSWERED INPUT STEPS, KEPT ON THE RAIL (cinatra#3068 fix leg 2)
  //
  // The run's FIRST step is the agent's own input form, and this screen is
  // where a run arrives once that form has been answered. The ratified drawing:
  // "A resolved gate stays on the rail as read-only history -- its entry keeps
  // its place and records how it was settled ... so the rail is the run's whole
  // lifecycle at a glance, not just its live tip." It did not keep its place:
  // the answered entry left the rail and the schedule renumbered to 1, so the
  // step the person had just taken was drawn nowhere at all. It stays now,
  // settled, opening its own read-only reading, and the three steps below it
  // renumber around however many stand above them.
  //
  // THE RESOLVED SCHEMA, the same one the run page reads and the setup loop
  // walks: a stored schema that is empty names no step for exactly the agents
  // whose form the loop still asks.
  const triggerInputSchema = await resolveTemplateInputSchema(template);
  const runInputSteps = run
    ? buildRunInputSteps({
        required: triggerInputSchema.required,
        properties: triggerInputSchema.properties,
        inputParams,
        // This screen is never the input moment -- a run reaches it by having
        // answered -- so no form is open here and every answered one is history.
        atInputMoment: false,
      })
    : [];
  const inputRailSteps: RunSurfaceRailStep[] = runCarriesInputSteps(
    runInputSteps,
    false,
  )
    ? buildRunInputRailSteps(runInputSteps, null)
    : [];
  const setupRailSteps: RunSurfaceRailStep[] = buildSetupRailSteps(setupSteps, inputRailSteps.length);
  const railSteps: RunSurfaceRailStep[] = [...inputRailSteps, ...setupRailSteps];

  return (
    <Main className="min-h-screen">
      <AgentPageLayout
        agentId={agentId}
        instanceId={instanceId}
        activeTab={scheduleRouteActiveTab({ persistentScheduleTab: showPersistentTab })}
        templateName={template.name}
        initialRunName={run?.title ?? ""}
        runId={run?.id ?? null}
        isPublished={template.status === "published"}
        // cinatra#2487: the SAME predicate as the other routes (was `!!run`,
        // which put a Trigger tab in the strip on /trigger that /setup and
        // /permissions did not show for the same run — a strip that changed
        // between tabs, i.e. the defect this issue exists to remove).
        //
        // Consequence, deliberate: while a run is in the TRANSIENT first-step
        // trigger form (no persistent scheduled/recurring trigger row yet) the
        // strip carries no Trigger tab, so no tab renders selected. That form is
        // a step in the run-start flow rather than a persistent tab, and the
        // documented product rule for the tab is unchanged: it appears only for
        // a scheduled/recurring trigger. The frame says so now too: see
        // `scheduleRouteActiveTab` above, which stops this route naming a tab
        // the strip does not carry.
        showTriggerTab={showPersistentTab}
        extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
        extensionHref={extensionHeaderLink?.extensionHref}
      >
        {/*
          Declared body role (Application Design — Agents §III, row "Trigger —
          the schedule form"): "A single-column schedule / control stack. Narrow
          is §VII's stated home for exactly this shape." Both readings of the
          schedule step — the first-step schedule form and the schedule this run
          already carries — are that shape, so both declare Narrow. Narrow is an
          inset: it sits flush-left INSIDE the frame and never resizes the frame,
          which is what lets either of them stand in the two-column frame below.
        */}
        {run ? (
          /* THE SETUP RUN PAGE, AS THE TWO-COLUMN RUN SURFACE (cinatra#2970) —
             AND IT STAYS THE SCREEN ONCE A SCHEDULE IS ARMED (cinatra#3004).
             The steps on the left, the selected step's surface on the right —
             the same frame every other run-page state draws, and the same
             column anchors the capture recorder measures on them.

             THE SCHEDULE IS A READING INSIDE THE SCHEDULE STEP, never a screen
             of its own: the retired drawing took the whole page — a summary of
             the configuration, a tree of held steps, and a Cancel that DELETED
             the trigger row, which took the run's own ending with it since every
             refusal the service makes reads that row. What the step draws now is
             the schedule form in the state the run's schedule is in, whose
             ending is **Cancel schedule** — it stops the schedule and leaves the
             record standing. So the reader who presses Continue here comes back
             to this rail with the armed form in the step they pressed, and the
             tab strip's Schedule row keeps naming the surface they are on.

             The surface takes the FRAME width because it is a two-column frame,
             not a form; the schedule step inside it declares Narrow for itself. */
          <AgentPanelBody role="frame">
            <div
              className="flex items-start gap-6"
              data-run-detail-contract=""
              data-conformance-id="run-surface"
            >
              <RunSurfaceRail steps={railSteps} initialSelection="schedule" />
            </div>
          </AgentPanelBody>
        ) : (
          /* No run to name steps for (`/trigger` reached with `new`): the form
             stands alone, exactly as it did. */
          scheduleFormSurface
        )}
      </AgentPageLayout>
    </Main>
  );
}
