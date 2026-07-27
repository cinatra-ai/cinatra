import { notFound, redirect } from "next/navigation";
import { inArray } from "drizzle-orm";
import { Main } from "@/components/layout/main";
import { getAuthSession, isPlatformAdmin, resolveOrgRoleForSession } from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthUsers,
  readOrgsWithTeamsForUser,
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
import { getRunRecommendations } from "./recommendation-interception";
import { getAssignedSkillIdsForAgent } from "@/lib/agents-store";
import {
  readRunSelectedSkillRevisions,
  hasRunRecommendationSkip,
} from "@/lib/run-selected-skill-revisions";
import {
  RunRecommendationChipRow,
  type RunRecommendationDecision,
} from "./run-recommendation-chip-row";
import type { RecommendedSkillForChip } from "./server-actions";
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
import { type SerializedAgentRunMessage } from "./agentic-run-panel";
import { AgentPageLayout } from "./agent-page-layout";
import { OrchestratorStepperPanel } from "./orchestrator-stepper-panel";
import { TriggerScreenClient } from "./trigger-screen-client";
import { estimateRunDuration } from "./trigger-duration-estimate";
import { TriggerTabClient } from "./trigger-tab-client";
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

type ScreenProps = {
  agentId: string;          // template slug from URL
  instanceId: string;       // runId or "new"
  searchParams?: Record<string, string | string[] | undefined>;
};

function buildExtensionHeaderLink(packageName: string | null | undefined) {
  if (!packageName) return null;
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
  const showTriggerTab = trigger !== null && (trigger.triggerType === "scheduled" || trigger.triggerType === "recurring");

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

  // Pre-generate a unique run name so the title shows immediately on load.
  // Only runs that have started (not pending_input) get a name here; abandoned
  // pending_input runs skip auto-naming to avoid wasting numbered slots.
  const runName =
    run && run.status !== "pending_input"
      ? await ensureRunTitle(run, template.name)
      : run?.title ?? "";
  const extensionHeaderLink = buildExtensionHeaderLink(template.packageName);

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
  // gate — woven into the rail as "Core analysis" entries beneath each gate.
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

  // ── Run-start recommendation chip-row (cinatra#2067, epic #2037 C3) ──────
  // The chip-row appears ONLY when the run holds at the recommendation
  // interception (a parked continuation) — or, once decided, as a read-only
  // summary (a released park). No park ⇒ no row (policy-forbidden / skipped /
  // empty-candidate / headless runs proceed with nothing shown). The park is a
  // plain run-scoped read behind the access door already cleared above.
  const recommendationPark = run ? await readRecommendationParkForRun(run.id) : null;
  const recommendationHeld = recommendationPark?.status === "parked";
  let recommendationDecision: RunRecommendationDecision | null = null;
  let initialRecommendations: RecommendedSkillForChip[] = [];
  if (run && recommendationPark) {
    if (recommendationHeld) {
      // Server-prefetch the candidates so the chip-row renders them immediately.
      recommendationDecision = { kind: "pending" };
      const packageName = template.packageName ?? undefined;
      if (packageName) {
        try {
          const assigned = await getAssignedSkillIdsForAgent(packageName);
          let intentPromptText = "";
          try {
            intentPromptText = JSON.stringify(run.inputParams ?? {});
          } catch {
            intentPromptText = "";
          }
          const recs = await getRunRecommendations({
            agentId: packageName,
            intent: { promptText: intentPromptText },
            restrictToSkillIds: assigned,
          });
          initialRecommendations = recs.map((r) => ({
            skillId: r.skillId,
            skillRevisionId: r.skillRevisionId,
            name: r.name,
            score: r.score,
            rank: r.rank,
            recommended: r.recommended,
            scoredFeatures: r.scoredFeatures,
          }));
        } catch {
          initialRecommendations = [];
        }
      }
    } else {
      // Released — a decided hold. Confirmed (selection rows) vs skipped.
      const selected = readRunSelectedSkillRevisions(run.id);
      if (selected.length > 0) {
        recommendationDecision = { kind: "confirmed", skillNames: selected.map((s) => s.skillId) };
      } else if (hasRunRecommendationSkip(run.id)) {
        recommendationDecision = { kind: "skipped" };
      }
    }
  }

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
          <div className="flex items-start gap-6" data-run-detail-contract="" data-conformance-id="run-surface">
            {run.status !== "pending_input" && rail.entries.length > 0 && (
              <RunStepRailPanel
                entries={rail.entries}
                activeOrdinal={rail.activeOrdinal}
                reviewHrefBase={reviewHrefBase}
              />
            )}
            <div className="min-w-0 flex-1">
              {/* Run-start recommendation chip-row (cinatra#2067, C3). A held run
                  (parked recommendation continuation) shows the interactive
                  confirm/adjust/skip chip-row at the run-start position, before
                  any work; a released hold shows the read-only decided summary. */}
              {recommendationDecision && template.packageName ? (
                <div className="mb-4">
                  <RunRecommendationChipRow
                    runId={run.id}
                    agentPackageName={template.packageName}
                    promptText={(() => {
                      try {
                        return JSON.stringify(run.inputParams ?? {});
                      } catch {
                        return "";
                      }
                    })()}
                    initialRecommendations={initialRecommendations}
                    decision={recommendationDecision}
                  />
                </div>
              ) : null}
              {/* Render setup INTERRUPT events inline on the Setup tab.
                  Only rendered once the run has been triggered (status !== pending_input). */}
              {run.status !== "pending_input" && (
                ((template.type === "orchestrator" || template.type === "flow") || stepperSteps.length > 0) && template.sourceType !== "external" ? (
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
                    initialStreamedText={run.streamedText ?? ""}
                  />
                )
              )}
            </div>
          </div>
        ) : (
          <div className="soft-panel rounded-card p-6">
            <p className="text-sm text-muted-foreground">No run selected.</p>
          </div>
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
  const extensionHeaderLink = buildExtensionHeaderLink(template.packageName);

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
          <div className="soft-panel rounded-card p-6 flex flex-col gap-2">
            <h2 className="text-base font-semibold text-foreground">
              No run selected
            </h2>
            <p className="text-sm text-muted-foreground">
              Start a run to view or configure its access policy.
            </p>
          </div>
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
  // Multi-org: readOrgsWithTeamsForUser returns ALL orgs the actor belongs to
  // with their teams nested.
  // -------------------------------------------------------------------------

  const orgs = actorUserId
    ? await readOrgsWithTeamsForUser(actorUserId)
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
        extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
        extensionHref={extensionHeaderLink?.extensionHref}
      >
        {scopeReason && (
          <p className="text-xs text-muted-foreground">
            {scopeReason}
          </p>
        )}
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
  const extensionHeaderLink = buildExtensionHeaderLink(template.packageName);

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
        showTriggerTab={!!run}
        extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
        extensionHref={extensionHeaderLink?.extensionHref}
      >
        {showPersistentTab && trigger && run ? (
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
        ) : (
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
        )}
      </AgentPageLayout>
    </Main>
  );
}
