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
import { resolveEffectivePolicy, buildScopeReason } from "./auth-policy";
import type { ActorRoleHints } from "./auth-policy";
import { AuthzError } from "@/lib/authz";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
// agent_run mounts the generic ExtensionPermissionsClient.
// Type re-exports (AvailableScopes, CoOwnerView) originate from their
// canonical sources to keep this file decoupled from the
// permissions-tab-client.tsx wrapper.
import { ExtensionPermissionsClient } from "@/components/extension-permissions-client";
import type { OwnerView as CoOwnerView } from "@/components/permissions-form";
import type { AvailableScopes } from "@/components/access-combobox-hierarchical";
import { removeRunOwner } from "./run-sharing-actions";
import { RunAgentButton } from "./run-dialog";
import { createAndTriggerRunWithContext, buildSubmissionMapByStepIndex, type SubmissionMapEntries } from "./run-actions";
import { SetupCompletionWatcher } from "./setup-completion-watcher";
import { AgenticRunPanel, type SerializedAgentRunMessage } from "./agentic-run-panel";
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

async function shouldShowTriggerTabForRun(runId: string | null): Promise<boolean> {
  if (!runId) return false;
  const trigger = await readRunTriggerByRunId(runId);
  return trigger !== null && (trigger.triggerType === "scheduled" || trigger.triggerType === "recurring");
}

async function resolveTemplateForActor(agentId: string) {
  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;
  return readAgentTemplateBySlug(agentId, { actorUserId, includeNonPublished: true });
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

  // Only HITL steps (requiresApproval === true) appear in the stepper.
  const policySteps = template.approvalPolicy?.steps ?? [];
  const hitlSteps = policySteps
    .filter((s) => !!(s as { xRenderer?: string }).xRenderer)
    .map((s, i) => ({
      index: i + 1,
      stepNumber: s.stepNumber,
      xRenderer: (s as { xRenderer?: string }).xRenderer,
      childAgentPackageName: (s as { childAgent?: { packageName?: string } }).childAgent?.packageName,
      label:
        (s as { name?: string }).name ??
        (s as { description?: string }).description ??
        `Step ${s.stepNumber}`,
      _policyDescription: (s as { description?: string }).description ?? null,
    }));

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
          policySteps as ReadonlyArray<{ stepNumber: number; gateCount?: number; hitlOwnedBy?: string; xRenderer?: string }>,
          hitlSteps.map((h) => ({ index: h.index, stepNumber: h.stepNumber })),
        )
      : [];

  // Trigger gate: if no trigger row exists, replace workspace content
  // with the first-step trigger form.
  const trigger = run ? await readRunTriggerByRunId(run.id) : null;
  const showTriggerTab = trigger !== null && (trigger.triggerType === "scheduled" || trigger.triggerType === "recurring");

  // Pre-generate a unique run name so the title shows immediately on load.
  // Only runs that have started (not pending_input) get a name here; abandoned
  // pending_input runs skip auto-naming to avoid wasting numbered slots.
  const runName =
    run && run.status !== "pending_input"
      ? await ensureRunTitle(run, template.name)
      : run?.title ?? "";
  const extensionHeaderLink = buildExtensionHeaderLink(template.packageName);

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
          run && run.status === "pending_input" ? (
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
          <>
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
                  policySteps={policySteps as ReadonlyArray<{ stepNumber: number; gateCount?: number; hitlOwnedBy?: string; xRenderer?: string }>}
                />
              ) : (
                <SetupCompletionWatcher
                  runId={run.id}
                  agentId={agentId}
                  instanceId={instanceId}
                  initialStatus={run.status}
                  initialError={run.error ?? null}
                  initialMessages={[]}
                  agUiEnabled={run.agUiEnabled}
                  agentPackageName={agentId}
                  traceId={run.traceId ?? undefined}
                  requiredFields={required}
                  initialInputParams={(run.inputParams ?? {}) as Record<string, unknown>}
                  noRedirect={template.type === "orchestrator" || template.type === "flow" || !!run.parentRunId}
                />
              )
            )}
          </>
        ) : (
          <div className="soft-panel rounded-card p-6">
            <p className="text-sm text-muted-foreground">No run selected.</p>
          </div>
        )}
      </AgentPageLayout>
    </Main>
  );
}

export async function RunScreen({ agentId, instanceId }: ScreenProps) {
  const session = await getAuthSession();
  const actorUserId = session?.user?.id ?? null;
  // Admin override for cross-screen consistency.
  const isAdmin = isPlatformAdmin(session);
  const template = await readAgentTemplateBySlug(agentId, {
    actorUserId,
    includeNonPublished: true,
  });
  if (!template) notFound();

  // Pass actor + roles so readAgentRunById
  // enforces effectivePolicy (runDataVisibility). The manual co-owner gate
  // is replaced by enforceRunAccess("read") inside readAgentRunById.
  const runScreenActor: PrimitiveActorContext = { actorType: "human", source: "ui", userId: actorUserId ?? undefined };
  const runScreenRoles: ActorRoleHints = {
    platformRole: isAdmin ? "platform_admin" : "member",
    actorOrganizationId: session?.session?.activeOrganizationId ?? undefined,
  };
  let run: Awaited<ReturnType<typeof readAgentRunById>> = null;
  if (instanceId !== "new") {
    try {
      run = await readAgentRunById(instanceId, runScreenActor, runScreenRoles);
      if (!run) notFound();
    } catch (err) {
      if (err instanceof AuthzError) notFound();
      throw err;
    }
  }

  const rawMessages = run ? await readAgentRunMessages(run.id) : [];
  const initialMessages: SerializedAgentRunMessage[] = rawMessages.map((m) => ({
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

  const runName = run ? await ensureRunTitle(run, template.name) : "";
  const extensionHeaderLink = buildExtensionHeaderLink(template.packageName);

  return (
    <Main className="min-h-screen">
      <AgentPageLayout
        agentId={agentId}
        instanceId={instanceId}
        activeTab="run"
        templateName={template.name}
        initialRunName={runName}
        runId={run?.id ?? null}
        isPublished={template.status === "published"}
        showTriggerTab={await shouldShowTriggerTabForRun(run?.id ?? null)}
        extensionIdentifier={extensionHeaderLink?.extensionIdentifier}
        extensionHref={extensionHeaderLink?.extensionHref}
      >
        {run ? (
          <AgenticRunPanel
            runId={run.id}
            initialStatus={run.status}
            initialError={run.error ?? null}
            initialMessages={initialMessages}
            agUiEnabled={run.agUiEnabled}
            agentPackageName={template.packageName ?? agentId}
            traceId={run.traceId ?? undefined}
            inputParams={(run.inputParams ?? {}) as Record<string, unknown>}
            templateId={template.id}
            initialStreamedText={run.streamedText ?? ""}
          />
        ) : (
          <div className="soft-panel rounded-card p-6">
            <p className="text-sm text-muted-foreground">No run selected.</p>
          </div>
        )}
      </AgentPageLayout>
    </Main>
  );
}



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

  // Pre-filter `availableScopes` for the agent_run permissions
  // form to only show scopes within the parent agent_template's policy.
  // Authoritative rejection lives server-side in
  // `saveExtensionAccessPolicy` (assertAgentRunPolicyContainedByTemplate);
  // this filter is the UX layer so the dropdown stops inviting users to
  // pick scopes that would be rejected. Read-side policy resolution stays
  // unchanged — grandfathered runs remain readable.
  const { filterAvailableScopesForParentPolicy } = await import("@cinatra-ai/extensions/scope-containment-filter");
  const runScopedAvailableScopes = filterAvailableScopesForParentPolicy(
    availableScopes,
    template.agentAuthPolicy ?? {
      runListVisibility: "owner",
      runDataVisibility: "owner",
      runExecuteVisibility: "owner",
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
  const visibility = effectivePolicy.runListVisibility;
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
          availableScopes={runScopedAvailableScopes}
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
