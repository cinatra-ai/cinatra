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
import { listReviewGatesForRun, readVerificationRecordsForGates } from "./artifact-review-gate-store";
import { readLifecycleDecisionsForRun } from "./lifecycle-policy-store";
import { buildRunStepRail, type RailMessage } from "./run-step-rail";
import { RunStepRailPanel } from "./run-step-rail-panel";
import { readRecommendationParkForRun } from "./recommendation-hold";
import { deriveRunHitlContext } from "./hitl-context";
import { RecommendationHoldCard } from "./run-recommendation-chip-row";
import { LifecycleCardSurfaceProvider } from "./lifecycle-card-runtime";
// §VII's card on the `run_card` host (cinatra#2789, epic #2784 S9e) — see the
// mount below for what it draws and what it deliberately does not.
import { VerificationSummaryCard } from "./verification-summary-card";
import { LIFECYCLE_VIEW_SCHEMA_VERSION } from "./review-gate-card";
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
import { TriggerStepWatcher } from "./trigger-step-watcher";
import { type SerializedAgentRunMessage } from "./agentic-run-panel";
import { AgentPageLayout, AgentPanelBody } from "./agent-page-layout";
import { OrchestratorStepperPanel } from "./orchestrator-stepper-panel";
import { TriggerScreenClient } from "./trigger-screen-client";
import { estimateRunDuration } from "./trigger-duration-estimate";
import { TriggerTabClient } from "./trigger-tab-client";
// §VI's card on the `run_card` host (cinatra#2788, epic #2784 S9d), reached
// through the run page's SCHEDULE STEP — see the mount below.
import { ScheduleRailStep } from "./schedule-rail-step";
import { readRunTriggerByRunId } from "./trigger-store";
import type { GatedStep } from "./trigger-infer-side-effects";
import cronstrue from "cronstrue";

// ---------------------------------------------------------------------------
// Trigger tab visibility helper.
//
// Visibility rule:
//   - agent_run_triggers row exists AND triggerType IN ('scheduled','recurring')
//     → show the persistent Trigger tab (TriggerTabClient)
//   - otherwise → show the first-step form (TriggerScreenClient)
//
// Exported so the unit test can lock the rule independently of DB / auth.
// ---------------------------------------------------------------------------
export function shouldShowPersistentTab(
  trigger: { triggerType: string } | null,
): boolean {
  return (
    !!trigger &&
    (trigger.triggerType === "scheduled" || trigger.triggerType === "recurring")
  );
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
 * It gates the NOTICE only. The form itself always renders: this standalone
 * form is the only way to give a finished immediate run a scheduled/recurring
 * trigger (`shouldShowPersistentTab` routes only scheduled/recurring rows to the
 * persistent tab), and a recurring trigger clones a fresh run — so arming one
 * stays meaningful however this run itself ended.
 *
 * Exported so the regression test can lock BOTH halves without a DB or session.
 */
export function shouldShowFinishedRunNotice(
  trigger: { triggerType: string } | null,
  runStatus: string | null | undefined,
): boolean {
  return trigger !== null && isTerminalRunStatus(runStatus);
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
 * The run statuses a run holds BEFORE it has ever run (cinatra#2788, S9d).
 *
 * `armed` and `pending_trigger` are the schedule's own states — the trigger is
 * set and the agent is waiting for it — and `pending_input` is the setup that
 * precedes both. None of them can carry an execution record, so none of them
 * has run progress to show.
 */
const PRE_EXECUTION_RUN_STATUSES: ReadonlySet<string> = new Set([
  "pending_input",
  "pending_trigger",
  "armed",
]);

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
  const hitlSteps = buildRunStepperSteps(policySteps as ReadonlyArray<RunStepperPolicyStep>);

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
  const scheduleRailRef = run && trigger ? encodeScheduleRunRef({ runId: run.id }) : null;
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
  const recommendationHeld =
    (run ? await readRecommendationParkForRun(run.id) : null)?.status === "parked";

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

  // Has the agent run at all? The schedule step is the run detail's first paint
  // while it has not (cinatra#2788, S9d) — there is no progress to show, and
  // plan (A) §7.2 step 5 forbids showing one with the schedule.
  const opensOnScheduleStep = runDetailOpensOnSchedule({
    hasScheduleStep: scheduleRailRef !== null,
    hasExecution: runHasExecutionRecord({
      runStatus: run?.status ?? null,
      stepResultCount: run?.stepResults?.length ?? 0,
      runMessageCount: completedRunMessages.length,
      streamedTextLength: (run?.streamedText ?? "").length,
    }),
    recommendationHeld,
  });

  // The scheduling step's duration banner, computed ONLY on the branch that
  // draws it (cinatra#2952). `estimateRunDuration` falls through to an LLM
  // analysis when a template has too little run history, so the ordinary run
  // page must never pay for it. Best-effort: the form states "Unavailable."
  // for a null estimate, which is a better page than a failed render.
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
        activeTab="setup"
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
              const railDraws =
                run.status !== "pending_input" &&
                rail.entries.length > 0 &&
                screenHostsStepRail({
                  panel: runDetailPanel,
                  stepperStepCount: stepperSteps.length,
                });
              // The page's OWN rail rows. The schedule row is drawn by the step
              // component rather than by this rail because the live orchestrator
              // column is the rail on the flow branch (`screenHostsStepRail`),
              // and the plan puts the schedule step above the run's steps on
              // every branch — not only the one where the server-rendered rail
              // happens to draw.
              const railNode = railDraws ? (
                <RunStepRailPanel
                  entries={rail.entries}
                  activeOrdinal={rail.activeOrdinal}
                  reviewHrefBase={reviewHrefBase}
                  stepOffset={scheduleRailRef ? 1 : 0}
                />
              ) : null;
              // A COLUMN with a GAP, not a margin on the row above. The card
              // below resolves its own state on the client and renders NO DOM at
              // all when there is no hold — the overwhelmingly common case — so a
              // wrapper carrying `mb-4` would leave a 1rem hole above the panel on
              // every ordinary run. A flex gap only ever applies BETWEEN rendered
              // children, which is the spacing that was actually meant.
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
              {screenHostsRecommendationCard(runDetailPanel) ? (
                <LifecycleCardSurfaceProvider host="run_card">
                  <RecommendationHoldCard
                    runId={run.id}
                    agentPackageName={template.packageName ?? ""}
                    wireRef={null}
                  />
                </LifecycleCardSurfaceProvider>
              ) : null}
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
                    inputParams={inputParams}
                    requiredFields={required}
                    properties={properties}
                    setupComplete={setupComplete}
                    durationEstimate={triggerStepDurationEstimate}
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
                    policySteps={policySteps as ReadonlyArray<{ stepNumber: number; gateCount?: number; hitlOwnedBy?: string; xRenderer?: string; firesRendererGate?: boolean }>}
                    // cinatra#2739: this panel's column is THE step rail on this
                    // branch, so the merged rail's trailing rows — review gates,
                    // verifications, lifecycle decisions — ride down into it
                    // instead of being drawn by a second column beside it.
                    railExtras={railExtras}
                    reviewHrefBase={reviewHrefBase}
                  />
                ) : (
                  <SetupCompletionWatcher
                    runId={run.id}
                    agentId={agentId}
                    instanceId={instanceId}
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
                  />
                )
              )}
                </>
              );
              // THE TWO COLUMNS. With a schedule, the schedule step owns them:
              // it heads the rail and it opens ON THE RIGHT, in the run detail,
              // never under its own row (plan (A) §7.2 step 5 and the ratified
              // drawing `design-run-surface-rail-and-gate.png`). Without one,
              // the surface is what it always was.
              if (scheduleRailRef) {
                return (
                  <ScheduleRailStep
                    host="run_card"
                    cardRef={scheduleRailRef}
                    displayStep={1}
                    rail={railNode}
                    detail={detailNode}
                    initialSelection={opensOnScheduleStep ? "schedule" : "detail"}
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
  //   - row exists AND triggerType IN ('scheduled','recurring') → persistent tab
  //   - otherwise → first-step form
  const trigger = run ? await readRunTriggerByRunId(run.id) : null;
  const showPersistentTab = shouldShowPersistentTab(trigger);

  // Server-rendered admin role flag is hoisted to the top of TriggerScreen
  // so the ownership check can apply the admin override. Same comma-split
  // parser as `isPlatformAdmin`.
  // Defense-in-depth alongside the releaseTriggerNow server-action role
  // check.

  // Server-side cron preview (mirrors the client-side cronstrue formatting
  // in trigger-screen-client.tsx) so the persistent tab renders the same
  // human-readable schedule label without re-parsing on the client.
  let cronPreview: string | null = null;
  if (trigger?.triggerType === "recurring" && trigger.cronExpression) {
    try {
      cronPreview = cronstrue.toString(trigger.cronExpression);
    } catch {
      cronPreview = null;
    }
  }

  // gatedSteps[] is persisted as JSON-as-text on agent_templates.gated_steps
  // and deserialized by the store layer to GatedStep[] | null. Templates with
  // NULL default to an empty array here.
  const gatedSteps: GatedStep[] = template.gatedSteps ?? [];

  return (
    <Main className="min-h-screen">
      <AgentPageLayout
        agentId={agentId}
        instanceId={instanceId}
        activeTab="trigger"
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
        // a scheduled/recurring trigger. Hoisting that transient step out of the
        // tab frame entirely is the cleaner end state and is left as follow-up.
        showTriggerTab={showPersistentTab}
        extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
        extensionHref={extensionHeaderLink?.extensionHref}
      >
        {/*
          Declared body role (Application Design — Agents §III, row "Trigger —
          the schedule form"): "A single-column schedule / control stack. Narrow
          is §VII's stated home for exactly this shape." Both trigger panels —
          the first-step schedule form and the configured-trigger summary +
          controls — are that shape, so both declare Narrow. Narrow is an inset:
          it sits flush-left INSIDE the frame and never resizes the frame.
        */}
        {showPersistentTab && trigger && run ? (
          <AgentPanelBody role="narrow">
          <TriggerTabClient
            agentId={agentId}
            runId={run.id}
            templateId={template.id}
            isAdmin={isAdmin}
            trigger={{
              triggerType: trigger.triggerType as "scheduled" | "recurring",
              scheduledAt: trigger.scheduledAt
                ? trigger.scheduledAt.toISOString()
                : null,
              cronExpression: trigger.cronExpression,
              timezone: trigger.timezone,
              enabled: trigger.enabled,
              releasedAt: trigger.releasedAt
                ? trigger.releasedAt.toISOString()
                : null,
              cronPreview,
            }}
            gatedSteps={gatedSteps}
          />
          </AgentPanelBody>
        ) : (
          <AgentPanelBody role="narrow">
          {/*
            cinatra#2482 — finished-run CONTEXT, above the form rather than
            instead of it.

            The reported repro ends on this screen with no idea that the run is
            over, so the state has to be said out loud. It must NOT replace the
            form though: `shouldShowPersistentTab` sends only scheduled/recurring
            rows to the persistent tab, so this standalone form is the ONLY way
            to give a finished immediate run a recurring or scheduled trigger —
            and a recurring trigger clones a fresh run, so arming one here is
            meaningful however this run itself ended. Hiding the form would take
            that away (codex round-B finding).

            "Run right after setup" on an already-triggered finished run is the
            one thing that cannot work, and `setRunTriggerForActor` now refuses
            exactly that with a message the form renders inline — no silent
            success, and no bounce back to the run view.
          */}
          {run && shouldShowFinishedRunNotice(trigger, run.status) ? (
            <div
              className="soft-panel rounded-card mb-4 flex flex-col items-start gap-2 p-4"
              data-run-finished-notice=""
            >
              <h2 className="text-sm font-semibold text-foreground">
                This run has already finished
              </h2>
              {/* Copy names RECURRING specifically. Codex round 2: only a
                  recurring trigger clones a fresh run per fire — a one-off
                  `scheduled` arm on a finished run is a pre-existing no-op
                  (trigger-release-job skips an unarmed run), so promising that
                  "a schedule" starts a fresh run would overstate it. */}
              <p className="text-sm text-muted-foreground">
                It can&apos;t be run again. You can still give it a recurring
                schedule below — each recurrence starts a fresh run.
              </p>
              <Link
                href={`/agents/${agentId}/${encodeURIComponent(instanceId)}`}
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                data-action="open-finished-run"
              >
                View this run
              </Link>
            </div>
          ) : null}
          <TriggerScreenClient
            agentId={agentId}
            instanceId={instanceId}
            templateId={template.id}
            isAdmin={isAdmin}
            inputParams={inputParams}
            requiredFields={required}
            properties={properties}
            setupComplete={setupComplete}
            durationEstimate={durationEstimate}
          />
          </AgentPanelBody>
        )}
      </AgentPageLayout>
    </Main>
  );
}
