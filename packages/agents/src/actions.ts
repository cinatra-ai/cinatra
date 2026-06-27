import "server-only";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  requireAuthSession,
  requireAdminSession,
  buildCanDoOptsFromSession,
  isPlatformAdmin,
} from "@/lib/auth-session";
import { canDo, AuthzError, logAuditEvent } from "@/lib/authz";
import type { ResourceRef, OwnerLevel } from "@/lib/authz";
// Kernel-level authorization imports for installRegistryPackageAtScope.
// POLICY_VERSION keeps install audit rows aligned with the authz kernel.
// enforceResourceAccess + ResourceForAccessCheck implement the kernel
// belt-and-suspenders gate after the product-specific assertions run.
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import { enforceResourceAccess } from "@/lib/authz/enforce-resource-access";
// Build a typed PrimitiveActorContext from the Better Auth session so the
// kernel's user-owner short-circuit and role parsing fire correctly.
import { actorFromSession, type ActorRoleHints } from "@/lib/authz/build-actor-context";
import type { ResourceForAccessCheck } from "@/lib/authz/enforce-resource-access";
import { readProjectById } from "@/lib/projects-store-dao";
import { readProjectCoOwners } from "@/lib/project-co-owners-store";
import { readTeamForOrg, countOtherPlatformAdmins } from "@/lib/better-auth-db";
import { readConnectorConfigFromDatabase } from "@/lib/database";
import { buildAgentWorkspacePath } from "@/lib/agent-url";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import { approveReviewTaskInternal } from "./review-task-actions";
import {
  createAuditEvent,
  deleteAgentTemplate,
  readAgentTemplateById,
  readAgentTemplateByPackageName,
  readAgentRunById,
  readAgentRunByTaskId,
  readAgentVersionsByTemplate,
  readAgentVersionById,
  createAgentTemplate,
  createAgentVersion,
  createAgentRun,
  createShareBinding,
  createAgentFork,
  checkRegistryPermission,
  readRegistryEntryById,
  updateAgentTemplate,
  updateShareBinding,
  createAgentTemplateVersionIfChanged,
  rollbackAgentTemplateToVersion,
} from "./store";
import type { CompiledStep, AgentRunStatus } from "./store";
import { compileWorkflow } from "./compiler";
import { collectAllPrimitiveHandlers } from "@/lib/primitive-handlers";
import { publishAgentPackage } from "./verdaccio/client";
import {
  installAgentFromPackage,
  installAgentPackageWithDependencies,
} from "./install-from-package";
// Agent package-name validation is scope-agnostic.
import { derivePublishMetadataFromSnapshot } from "./verdaccio/publish-metadata";
// Explicit DI shape for publish/install paths.
// InstanceNamespaceNotConfiguredError is the typed signal the loader throws when
// the instance has no vendor-name set; publishToRegistry catches it and
// returns a structured failure.
import {
  FIRST_PARTY_PACKAGE_SCOPE,
  InstanceNamespaceNotConfiguredError,
  vendorScopeOfPackage,
} from "@cinatra-ai/registries";
import { readEffectivePublishScopeOverride } from "@/lib/dev-extensions";
import type { VerdaccioConfig } from "@cinatra-ai/registries";
// Gated-loader helpers for publish + install destination routing.
// Every publish path calls resolvePublishDestination(destination) after auth gate.
// Every install path calls resolveInstallEnvironment(extensionId) and injects args.
import {
  resolvePublishDestination,
  resolveInstallEnvironment,
} from "@cinatra-ai/extensions/destination-resolver";
import {
  updateAgentTemplateOrigin,
} from "./store";

// Accept any valid scoped npm name. Agents share package scopes with platform
// packages and use their own package.json names as canonical identifiers, so
// install/update actions only validate scoped npm package syntax.
function makeAgentPackageNameSchema() {
  return z
    .string()
    .regex(
      /^@[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/,
      "packageName must be a scoped package with lowercase alphanumeric + hyphens",
    );
}

function makeInstallRegistryInputSchema() {
  return z.object({
    packageName: makeAgentPackageNameSchema(),
    packageVersion: z.string().min(1).optional(),
    destination: z.enum(["builder", "run", "extensions"]).optional(),
  });
}

// Zod schema for installRegistryPackageAtScope.
// `level` enum INTENTIONALLY omits "user" and "workspace" — both are
// unsupported target scopes. A caller submitting "user" should fail Zod parse
// before any auth check.
function makeInstallRegistryAtScopeInputSchema() {
  return z.object({
    packageName: makeAgentPackageNameSchema(),
    packageVersion: z.string().min(1).optional(),
    destination: z.enum(["builder", "run", "extensions"]).optional(),
    target: z.object({
      level: z.enum(["organization", "team", "project"]),
      id: z.string().min(1),
    }),
  });
}

function makeUpdateRegistryInputSchema() {
  return z.object({
    packageName: makeAgentPackageNameSchema(),
    packageVersion: z.string().min(1).optional(),
  });
}

type SessionWithActiveOrganization = {
  session?: {
    activeOrganizationId?: string | null;
  } | null;
};

function getActiveOrganizationId(session: SessionWithActiveOrganization): string | undefined {
  return session.session?.activeOrganizationId ?? undefined;
}

// Run self-approval config (admin-overridable). Run-side analog of the
// agent-creation `agent_creation.allowSelfApproval` override (see
// mcp/agent-creation-request-handlers.ts). Stored under its OWN connector_config
// key — runs and agent-creation are distinct concerns, so they must not share
// one toggle. When true, the reviewer self-approval guard in approveReviewTask
// is disabled instance-wide even on multi-admin instances.
const RUN_SELF_APPROVAL_CONFIG_KEY = "agent_run";
type AgentRunConfig = { allowSelfApproval?: boolean };
function readAllowRunSelfApproval(): boolean {
  try {
    const cfg = readConnectorConfigFromDatabase<AgentRunConfig>(RUN_SELF_APPROVAL_CONFIG_KEY, {});
    return cfg.allowSelfApproval === true;
  } catch {
    return false;
  }
}

// Resolve the agent_run backing a synthetic approval task id so the
// self-approval guard can read run.runBy. Mirrors the run-resolution the
// approveReviewTaskInternal branches do for the two supported synthetic
// prefixes:
//   - "setup-{runId}"    -> readAgentRunById(runId)
//   - "wayflow-{taskId}" -> readAgentRunByTaskId(taskId), with the SAME
//                           Redis reverse-map fallback the resume path uses
//                           when agent_runs.a2a_task_id is stale.
// The wayflow- fallback MUST stay identical to the resolution in
// approveReviewTaskInternal (review-task-actions.ts) — otherwise the SoD guard
// resolves null on the stale-column race while the downstream helper still
// recovers and resumes the self-owned run, bypassing the multi-admin
// separation-of-duties block (#563).
//
// The result is a DISCRIMINATED outcome, not a bare run-or-null, because the two
// prefixes have different fail-safety contracts (this closes the TOCTOU the
// helper's independent re-resolution creates):
//   - kind: "resolved"  -> run found; the guard evaluates SoD against run.runBy.
//   - kind: "not-found" -> the SINGLE-source prefix (setup-) found no row. There
//       is exactly one resolution (readAgentRunById) shared with the helper, so
//       the guard and helper cannot disagree; the guard falls through and the
//       helper raises the canonical not-found error.
//   - kind: "unresolved-resumable" -> the DUAL-source wayflow- prefix could not
//       resolve a run from EITHER the a2a_task_id column or the Redis reverse-map
//       AT CHECK TIME, but the helper re-resolves both sources independently at
//       USE time and may then recover + resume the run. The guard therefore
//       cannot prove the resume is SoD-safe, so the caller MUST fail CLOSED.
type ApprovalRunResolution =
  | { kind: "resolved"; runBy: string | null }
  | { kind: "not-found" }
  | { kind: "unresolved-resumable" };

async function resolveRunForApprovalTask(
  taskId: string,
): Promise<ApprovalRunResolution> {
  if (taskId.startsWith("setup-")) {
    const run = await readAgentRunById(taskId.slice("setup-".length));
    return run ? { kind: "resolved", runBy: run.runBy } : { kind: "not-found" };
  }
  if (taskId.startsWith("wayflow-")) {
    const wayflowTaskId = taskId.slice("wayflow-".length);
    const run = await readAgentRunByTaskId(wayflowTaskId);
    if (run) return { kind: "resolved", runBy: run.runBy };

    // a2a_task_id column lost the per-gate update race (see
    // review-task-actions.ts wayflow- branch). Fall back to the authoritative
    // Redis task->run reverse-map so the SoD guard sees the same run the resume
    // path would recover. Dynamic import mirrors the resume path's
    // circular-dep avoidance (review-task-actions <- actions <- index <-
    // @cinatra-ai/a2a).
    const { resolveRunIdByWayflowTaskId } = await import("@cinatra-ai/a2a");
    const fallbackRunId = await resolveRunIdByWayflowTaskId(wayflowTaskId);
    if (fallbackRunId) {
      const fallbackRun = await readAgentRunById(fallbackRunId);
      if (fallbackRun) return { kind: "resolved", runBy: fallbackRun.runBy };
    }
    // Both wayflow- sources missed here, but the helper will re-resolve them
    // independently and could still resume. Fail closed.
    return { kind: "unresolved-resumable" };
  }
  return { kind: "not-found" };
}

// approveReviewTask

export async function approveReviewTask(
  taskId: string,
  values?: unknown,
  fieldName?: string,
  schemaSnapshot?: Record<string, unknown> | null,
): Promise<void> {
  "use server";
  // Core logic lives in approveReviewTaskInternal so the
  // external /api/a2a/resume route can call it with Bearer JWT auth instead
  // of requiring an admin session. This server action keeps the admin session
  // check as the auth layer for UI callers.
  //
  // `values` is forwarded so setup-field interrupts can
  // merge into agent_runs.inputParams atomically with the approval status
  // flip (one CAS UPDATE — see approveReviewTaskInternal, #76).
  //
  // `fieldName` is forwarded so setup paths can bypass the provenance read.
  // Default undefined preserves back-compat for all current callers.
  const session = await requireAdminSession();
  const userId = session.user.id;

  // Run-side self-approval guard (issue #563) — the run analog of the
  // agent-creation decide self-approval guard
  // (mcp/agent-creation-request-handlers.ts). This is the UI admin approval
  // path (the operator clicking Continue/Approve on a pending_approval run),
  // mirroring how the agent-creation guard lives in the admin decide handler —
  // NOT in the auth-neutral approveReviewTaskInternal helper (the A2A
  // service-account self-resume path stays unaffected, exactly as the creation
  // guard leaves the admin-authoring instant-grant path unaffected).
  //
  // Separation of duties: an admin who initiated a run must not rubber-stamp
  // their own run's HITL gate when ANOTHER platform_admin exists who could
  // review it instead.
  //
  // Single-admin exception (issue #563, run-side analog of #382/#392 /
  // PR #557): on an instance where the approving admin is the ONLY
  // platform_admin, there is no second reviewer who could ever clear the gate,
  // so an unconditional guard would be a permanent deadlock — the run sits in
  // pending_approval forever. When no OTHER platform_admin exists, SoD is
  // impossible and the sole admin is allowed to approve their own run. The
  // agent_run.allowSelfApproval connector_config override remains a global
  // escape hatch for instances that want self-approval even with multiple
  // admins. countOtherPlatformAdmins fails CLOSED (returns >=1 on a read
  // error), so an error keeps the guard on.
  if (!readAllowRunSelfApproval()) {
    const resolution = await resolveRunForApprovalTask(taskId);
    if (resolution.kind === "unresolved-resumable") {
      // Dual-source wayflow- resolution missed at check time, but
      // approveReviewTaskInternal re-resolves the column AND the Redis
      // reverse-map independently at use time and could still recover + resume
      // the run. The guard cannot prove that resume is SoD-safe (it never saw
      // run.runBy), so allowing it would reopen the multi-admin self-approval
      // bypass via a TOCTOU window. Fail CLOSED. (#563)
      throw new Error(
        "approval rejected: the run for this WayFlow task could not be resolved for the " +
          "separation-of-duties check; retry once the run's task mapping is consistent.",
      );
    }
    if (resolution.kind === "resolved" && resolution.runBy != null && resolution.runBy === userId) {
      const otherAdmins = await countOtherPlatformAdmins(userId);
      if (otherAdmins > 0) {
        throw new Error(
          "self-approval is disallowed: another platform admin must approve a run you initiated " +
            "(set connector_config.agent_run.allowSelfApproval=true to override).",
        );
      }
      // No other admin can review → fall through and allow the self-approval.
    }
    // kind === "not-found": single-source (setup-) prefix or unknown prefix
    // resolved no row. There is no dual-resolution TOCTOU here, so fall through;
    // approveReviewTaskInternal raises the canonical not-found error.
  }

  await approveReviewTaskInternal(taskId, userId, values, fieldName, schemaSnapshot);
}

// rejectReviewTask

export async function rejectReviewTask(taskId: string, reason?: string): Promise<void> {
  "use server";
  const session = await requireAdminSession();

  // ---------------------------------------------------------------------------
  // review_tasks table is gone. Real-UUID reject paths are no longer supported.
  // setup- prefix: mark run as failed directly.
  // ---------------------------------------------------------------------------
  if (taskId.startsWith("setup-")) {
    const runId = taskId.slice("setup-".length);
    const run = await readAgentRunById(runId);
    if (!run) throw new Error(`[rejectReviewTask] run ${runId} not found`);
    const { transitionRunStatus, RunTransitionError } = await import("./store");
    await transitionRunStatus(runId, run.status as AgentRunStatus, "failed").catch((err) => {
      if (err instanceof RunTransitionError && err.code === "stale_from_status") {
        // Race: another path terminated this run between our read and the CAS.
        // Safe to ignore — the run is terminal either way.
        return;
      }
      throw err;
    });
    console.log(`[rejectReviewTask] setup-path rejected run=${runId} actor=${session.user.id} reason=${reason ?? "(none)"}`);
    return;
  }

  // Any other ID (real UUID review task path) is not supported.
  throw new Error(
    `[rejectReviewTask] review task ${taskId} not found — ` +
    `real UUID review task paths are not supported.`,
  );
}

// ---------------------------------------------------------------------------
// updateAgentType
//
// Persists the `type` field on agent_templates. Type changes are allowed
// post-publish; the version diff engine emits a MAJOR bump so pinned A2A
// consumers keep resolving the old type until they upgrade.
// ---------------------------------------------------------------------------

const updateAgentTypeSchema = z.object({
  templateId: z.string().min(1),
  type: z.enum(["leaf", "proxy", "orchestrator", "parallel", "supervisor", "iterative"]),
});

export async function updateAgentType(
  templateId: string,
  type: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative",
): Promise<void> {
  "use server";
  const parsed = updateAgentTypeSchema.parse({ templateId, type });

  // Authorize: type changes trigger a MAJOR semver bump downstream and control
  // orchestrator sub-agent validation — require admin access (not just any
  // authenticated user). Mirrors the auth guard used by recompileAgentTemplate.
  const session = await requireAdminSession().catch(() => null);
  const userId = session?.user?.id ?? null;
  if (!userId) {
    throw new Error("unauthorized");
  }

  const template = await readAgentTemplateById(parsed.templateId);
  if (!template) {
    throw new Error("template not found");
  }

  // executionProvider is normalized to "wayflow". Type changes still require
  // an explicit write so the version-diff trigger, updatedAt bump, and
  // deserializer normalization fire consistently.
  const coercedExecutionProvider = "wayflow" as const;

  // Keeping the same path keeps the version-diff trigger, updatedAt bump, and
  // deserializer normalization consistent.
  await updateAgentTemplate(parsed.templateId, {
    type: parsed.type,
    executionProvider: coercedExecutionProvider,
  });

  revalidatePath(`/agents`);
}

// editAndReApproveItem and regenerateItem are intentionally absent. They
// depended entirely on planned_actions and review_tasks tables, and the
// email-outreach HITL flow that called them is retired.

// publishToRegistry — Verdaccio-backed server action.
//
// Publish guard with explicit DI:
//   1. Caller may pass `input.config: VerdaccioConfig` to bypass the loader
//      entirely.
//   2. Otherwise, the resolver keeps registry routing behind the auth gate.
//   3. If the loader throws `InstanceNamespaceNotConfiguredError`, the action
//      returns a discriminated failure rather than re-throwing — the publish
//      UI consumes this via the structured shape and disables the button.
//   4. All other errors are rethrown unchanged.

export type PublishToRegistryFailure = {
  ok: false;
  code: "INSTANCE_NAMESPACE_NOT_CONFIGURED";
  message: string;
};

export type PublishToRegistrySuccess = { ok: true };
export type PublishToRegistryResult = PublishToRegistrySuccess | PublishToRegistryFailure;

const INSTANCE_NAMESPACE_FAILURE_MESSAGE =
  "Instance vendor name is not configured. Visit /setup/name to provision a registry identity before publishing.";

export async function publishToRegistry(input: {
  templateId: string;
  semver: string;
  title: string;
  description?: string;
  changelog?: string;
  /**
   * Publish destination chosen via PublishDestinationPicker.
   * Defaults to "private" and routes through resolvePublishDestination after
   * the auth gate.
   */
  destination?: "private" | "public";
  /**
   * Explicit DI bypass. When provided, the action skips the gated loader
   * entirely. Tests rely on this to assert that the loader is NOT invoked when
   * an explicit config is threaded through. Takes precedence over `destination`.
   */
  config?: VerdaccioConfig;
}): Promise<PublishToRegistryResult> {
  "use server";

  // Auth FIRST, then config. This prevents anonymous callers from exercising
  // the token-decryption path and from using loader errors as an identity
  // oracle. Only authorized callers reach the loader.
  const session = await requireAuthSession();
  const userId = session.user.id;
  const isAdmin = isPlatformAdmin(session);
  const orgId = getActiveOrganizationId(session);
  if (!orgId) throw new Error("No active organization — cannot publish to registry");

  const template = await readAgentTemplateById(input.templateId);
  if (!template) throw new Error("Agent template not found");

  // Permission check — creator or admin
  if (template.creatorId !== userId && !isAdmin) {
    throw new Error("Not authorized to publish");
  }

  // Resolve destination via gated loader.
  // Auth gate ran above. Explicit DI config takes precedence.
  // resolvePublishDestination routes to the correct registry based on destination.
  // InstanceNamespaceNotConfiguredError is caught and translated to structured failure.
  const destination = input.destination ?? "private";
  // Dev-mode publish-scope override. Hard-ignored in prod by
  // readEffectivePublishScopeOverride. When set, the publish and origin-row
  // write both use resolvedConfig.packageScope as the single source of truth.
  const scopeOverride = readEffectivePublishScopeOverride();
  let resolvedConfig: VerdaccioConfig;
  try {
    if (input.config) {
      resolvedConfig = input.config;
    } else {
      resolvedConfig = await resolvePublishDestination(destination, {
        vendorScopeOverride: scopeOverride,
      });
    }
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      return {
        ok: false,
        code: "INSTANCE_NAMESPACE_NOT_CONFIGURED",
        message: INSTANCE_NAMESPACE_FAILURE_MESSAGE,
      };
    }
    throw e;
  }

  const versions = await readAgentVersionsByTemplate(input.templateId);
  if (!versions.length) {
    throw new Error("No version snapshot found — save the agent before publishing");
  }

  const version = versions[0]; // latest version (ordered by createdAt DESC)
  const publishMetadata = derivePublishMetadataFromSnapshot(version.snapshot);

  // Defense-in-depth: a deeper InstanceNamespaceNotConfiguredError can still surface
  // from inside publishAgentPackage (e.g. from a future internal helper that
  // re-loads). Convert any such throw into the same structured failure so the
  // UI receives a single shape.
  let publishResult: Awaited<ReturnType<typeof publishAgentPackage>> | null = null;
  try {
    publishResult = await publishAgentPackage(
      {
        template,
        version,
        semver: input.semver,
        title: input.title,
        description: input.description ?? template.description ?? undefined,
        changelog: input.changelog ?? undefined,
        riskLevel: publishMetadata.riskLevel,
        toolAccess: publishMetadata.toolAccess,
        hasApprovalGates: publishMetadata.hasApprovalGates,
      },
      resolvedConfig,
    );
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      return {
        ok: false,
        code: "INSTANCE_NAMESPACE_NOT_CONFIGURED",
        message: INSTANCE_NAMESPACE_FAILURE_MESSAGE,
      };
    }
    throw e;
  }

  // Persist origin coordinates after successful publish.
  // Tokens MUST NOT appear in origin; only opaque destinationId is written.
  //
  // Single source of truth: read the resolved scope from
  // resolvedConfig.packageScope, which already reflects the dev-mode override
  // if one is in play.
  //
  // Key the row update by template.packageName (stable identifier) while
  // recording origin.packageName = publishResult.packageName so the origin
  // reflects where the artifact actually lives.
  const scope = resolvedConfig.packageScope;
  const packageName = template.packageName;
  if (packageName && publishResult?.packageName) {
    try {
      await updateAgentTemplateOrigin(packageName, {
        packageName: publishResult.packageName,
        version: input.semver,
        destinationId: destination === "private" ? (resolvedConfig as { destinationId?: string }).destinationId ?? null : null,
        scope,
        visibility: destination,
        registryUrl: resolvedConfig.registryUrl,
      });
    } catch (originErr) {
      // Non-fatal — publish already succeeded; log and continue.
      console.warn("[publishToRegistry] Origin persistence failed:", originErr);
    }
  }

  redirect("/configuration/extensions");
}

// ---------------------------------------------------------------------------
// installRegistryPackageAtScope + product-specific authorization helpers +
// back-compat installRegistryPackage wrapper.
//
// installRegistryPackage is retained as a thin wrapper that delegates to
// installRegistryPackageAtScope with target.level = "organization" so existing
// call sites continue to work without modification (signature is preserved
// verbatim — Promise<void> + post-install redirect dispatch).
//
// This design keeps the product-specific target rules outside the kernel:
//   1. Target-scope authz is enforced by assertCanInstallAtTarget, regardless
//      of EFFECTIVE_GRANTS contents.
//   2. Project-target authz uses project owner OR co-owner OR team_admin of
//      the owning team.
//   3. Tenant-membership validation runs BEFORE persistence and rejects
//      cross-org forged ids with the same 403 as deny (no existence-leakage).
// ---------------------------------------------------------------------------

type InstallTarget = { level: "organization" | "team" | "project"; id: string };

type InstallActorRoleBag = {
  principalId: string;
  organizationId: string;
  platformRole?: "platform_admin" | "member";
  orgRole?: "org_owner" | "org_admin" | "member";
  teamRoles?: Record<string, "team_admin" | "member">;
};

/**
 * Product-specific install authorization. Enforces target-scope semantics
 * without trusting the kernel's EFFECTIVE_GRANTS. Throws AuthzError(403,
 * "forbidden") on deny.
 *
 * Rules:
 *  - organization: platform_admin OR org_admin OR org_owner
 *  - team: platform_admin OR actor.teamRoles[target.id] === "team_admin"
 *          (plain org_admin DENIES — they must be team_admin of THIS team)
 *  - project: platform_admin OR project owner/co-owner OR
 *             team_admin of the project's owning team
 */
async function assertCanInstallAtTarget(
  actor: InstallActorRoleBag,
  target: InstallTarget,
  // For project target — looked up by caller (assertTargetBelongsToActiveOrg)
  // to avoid a second DB round-trip. If absent for project target, helper
  // fails closed.
  projectOwnership?: { ownerUserIds: Set<string>; owningTeamId: string | null },
): Promise<void> {
  const isPlatformAdmin = actor.platformRole === "platform_admin";
  if (isPlatformAdmin) return; // short-circuit

  if (target.level === "organization") {
    if (actor.orgRole === "org_admin" || actor.orgRole === "org_owner") return;
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Install at organization scope requires org admin or owner role.",
    });
  }

  if (target.level === "team") {
    // EXPLICIT: org_admin without team_admin of THIS team → DENY.
    // Locked by install-registry-at-scope-authz.test.ts.
    if (actor.teamRoles?.[target.id] === "team_admin") return;
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Install at team scope requires team admin role on the target team.",
    });
  }

  // target.level === "project"
  if (!projectOwnership) {
    // Caller forgot to load it — fail closed.
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Project ownership context unavailable for install authorization.",
    });
  }
  // (a) Project owner / co-owner.
  if (projectOwnership.ownerUserIds.has(actor.principalId)) return;
  // (b) team_admin of the project's owning team.
  if (
    projectOwnership.owningTeamId &&
    actor.teamRoles?.[projectOwnership.owningTeamId] === "team_admin"
  ) {
    return;
  }
  throw new AuthzError({
    statusCode: 403,
    reason: "forbidden",
    message: "Install at project scope requires project ownership or team admin of the owning team.",
  });
}

/**
 * Tenant-membership validation. Confirms the target id belongs to the actor's
 * active organization. Not-found is treated identically to deny (same 403,
 * same message) — no existence-leakage about cross-org targets.
 *
 * Returns project ownership context as a side-effect when target is project,
 * so the caller can pass it into assertCanInstallAtTarget without a second
 * DB round-trip.
 *
 * Implementation notes (verified against canonical readers, NOT raw SQL):
 *  - team:    readTeamsForUser(actor.principalId, activeOrgId) — INNER JOINs
 *             public."teamMember" → public."team" filtered by team.organizationId.
 *             Cross-org forged team ids do NOT appear in the returned set.
 *  - project: readProjectById(target.id) → ProjectRecord with
 *             organization_id + (owner_level, owner_id) discriminated owner.
 *             Then readProjectCoOwners(projectId) for the co-owner set.
 *             cinatra.projects schema has NO "owning_team_id" column; the
 *             owning team is project.owner_id when project.owner_level === "team".
 */
async function assertTargetBelongsToActiveOrg(
  actor: InstallActorRoleBag,
  target: InstallTarget,
  activeOrgId: string,
): Promise<{ projectOwnership?: { ownerUserIds: Set<string>; owningTeamId: string | null } }> {
  if (target.level === "organization") {
    if (target.id !== activeOrgId) {
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: "Target organization is not the active organization.",
      });
    }
    return {};
  }

  if (target.level === "team") {
    // Cross-org forgery rejected here — readTeamForOrg filters by
    // team.organizationId, so any team id from a different org returns
    // null. Same 403, same message — no info leak about whether the
    // team exists in another tenant. Note: this is a tenant-level check
    // (does the team belong to this org?), not a membership check (is
    // the actor on the team?). The product authorization gate
    // (assertCanInstallAtTarget) handles the role-on-team requirement;
    // platform_admin must still pass this tenant gate so the install
    // cannot scope to a non-existent team.
    const team = await readTeamForOrg(target.id, activeOrgId);
    if (!team) {
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: "Target team not accessible.",
      });
    }
    return {};
  }

  // target.level === "project"
  const project = await readProjectById(target.id);
  if (!project || project.organizationId !== activeOrgId) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Target project not accessible.",
    });
  }

  // Build owner set — cinatra.projects uses (owner_level, owner_id) as the
  // discriminated owner. When owner_level === "user", owner_id is the
  // owning user id. The owning team (if any) is owner_id when owner_level
  // is "team". Co-owners always live in cinatra.project_co_owners.
  const ownerUserIds = new Set<string>();
  if (project.ownerLevel === "user" && project.ownerId) {
    ownerUserIds.add(project.ownerId);
  }
  const coOwners = await readProjectCoOwners(target.id);
  for (const co of coOwners) ownerUserIds.add(co.userId);

  const owningTeamId = project.ownerLevel === "team" ? project.ownerId : null;

  return {
    projectOwnership: { ownerUserIds, owningTeamId },
  };
}

/**
 * Resolve the kernel-required role bag from the Better Auth session. Mirrors
 * what auth-session.requireActorContext / canDo do, but specialised for the
 * install path so the caller has direct access to platformRole / orgRole /
 * teamRoles without going through the kernel conversion. Note: Production
 * today does NOT load teamRoles from any canonical store (Better Auth's
 * teamMember table has no role column); the field is plumbed through for
 * future wiring and is exercised only by the matrix tests that mock this
 * resolver.
 */
function readActorRolesForInstall(
  session: Awaited<ReturnType<typeof requireAuthSession>>,
  activeOrgId: string,
  orgRole: "org_owner" | "org_admin" | "member" | undefined,
): InstallActorRoleBag {
  const role = String(session.user.role ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isPlatformAdmin = role.includes("admin") || role.includes("platform_admin");
  // teamRoles cannot be derived from Better Auth's teamMember table (no
  // role column). The matrix tests inject this via the mocked actor; in
  // production, teamRoles is undefined and team-target installs deny by
  // default until the team_admin role bag is wired.
  const teamRoles = (session.user as unknown as {
    teamRoles?: Record<string, "team_admin" | "member">;
  }).teamRoles;
  return {
    principalId: session.user.id,
    organizationId: activeOrgId,
    platformRole: isPlatformAdmin ? "platform_admin" : "member",
    orgRole,
    teamRoles,
  };
}

/**
 * Server-side install with explicit target-scope. installRegistryPackage is a
 * thin wrapper around this function for back-compat.
 *
 * 9-step ordering (LOCKED — never reorder):
 *   1. Zod parse
 *   2. requireAuthSession + active-org guard
 *   3. resolve actor role bag (translates Better Auth "admin" → "platform_admin")
 *   4a. assertTargetBelongsToActiveOrg — tenant-membership validation (also loads
 *       project ownership when target is project)
 *   4b. assertCanInstallAtTarget — product-specific authorization
 *   5. enforceResourceAccess — kernel belt-and-suspenders gate
 *   6. resolveInstallEnvironment + build VerdaccioConfig
 *   7. installAgentPackageWithDependencies (threads ownerLevel + ownerId)
 *   8. logAuditEvent (allowed) — POLICY_VERSION + targetScope metadata
 *   9. Post-install dispatch (redirect by destination) — ported verbatim
 *      from the prior installRegistryPackage tail.
 */
export async function installRegistryPackageAtScope(input: {
  packageName: string;
  packageVersion?: string;
  destination?: "builder" | "run" | "extensions";
  target: { level: "organization" | "team" | "project"; id: string };
}): Promise<void> {
  "use server";
  // Step 1 — Zod parse BEFORE auth to avoid auth-gated parsing behavior
  // changes.
  const parsed = makeInstallRegistryAtScopeInputSchema().parse(input);

  // Step 2 — session + active-org guard.
  const session = await requireAuthSession();
  const orgId = getActiveOrganizationId(session);
  if (!orgId) {
    throw new Error(
      "No active organization — select one before installing a package.",
    );
  }

  // Step 3 — resolve actor role bag.
  const opts = await buildCanDoOptsFromSession(session);
  const actor = readActorRolesForInstall(session, orgId, opts.orgRole);

  // Helper: write a denied audit row. Must include targetScope metadata
  // and POLICY_VERSION.
  const writeAuditDenied = (): void => {
    void logAuditEvent({
      organizationId: orgId,
      actorPrincipalId: session.user.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "registry_package",
      resourceId: parsed.packageName,
      operation: "install",
      decision: "denied",
      policyVersion: POLICY_VERSION,
      metadata: { targetScope: { level: parsed.target.level, id: parsed.target.id } },
    });
  };

  // Steps 4a + 4b — tenant validation FIRST (loads project ownership when
  // applicable) THEN product-specific authorization.
  let projectOwnership:
    | { ownerUserIds: Set<string>; owningTeamId: string | null }
    | undefined;
  try {
    const tenantCheck = await assertTargetBelongsToActiveOrg(actor, parsed.target, orgId);
    projectOwnership = tenantCheck.projectOwnership;
    await assertCanInstallAtTarget(actor, parsed.target, projectOwnership);
  } catch (err) {
    writeAuditDenied();
    throw err;
  }

  // Step 5 — kernel belt-and-suspenders. If 4a/4b allowed but the kernel
  // disagrees, we still trust the kernel as the deeper invariant.
  // `project` is NOT a kernel ownership tier. The install TARGET is still
  // persisted as project/projectId downstream; the kernel
  // `ResourceForAccessCheck` must see the project's real owner, resolved so
  // the kernel decision mirrors `assertCanInstallAtTarget` exactly. Otherwise
  // the kernel belt-and-suspenders check would deny a real project owner:
  // `registry.install` is not a coOwner op, so passing owner ids only as
  // coOwnerUserIds never fires the short-circuit. Mirror the product gate's
  // allow ladder onto the three kernel-passable owner shapes:
  //   (a) actor is a project owner/co-owner → ('user', acting user) so the
  //       kernel user-owner short-circuit fires for THIS validated actor;
  //   (b) team-owned project → ('team', owningTeamId) → team-admin short-circuit;
  //   (c) otherwise → ('organization', orgId) (product gate already denied a
  //       non-owner/non-team-admin before we reach here; org grants apply).
  const actingUserId = session.user.id;
  const kernelOwner: { ownerLevel: OwnerLevel; ownerId: string } =
    parsed.target.level !== "project"
      ? { ownerLevel: parsed.target.level, ownerId: parsed.target.id }
      : projectOwnership?.ownerUserIds.has(actingUserId)
        ? { ownerLevel: "user", ownerId: actingUserId }
        : projectOwnership?.owningTeamId
          ? { ownerLevel: "team", ownerId: projectOwnership.owningTeamId }
          : { ownerLevel: "organization", ownerId: orgId };
  const installRef: ResourceForAccessCheck = {
    resourceType: "registry",
    resourceId: parsed.packageName,
    organizationId: orgId,
    ownerLevel: kernelOwner.ownerLevel,
    ownerId: kernelOwner.ownerId,
    visibility: null,
    coOwnerUserIds: projectOwnership ? Array.from(projectOwnership.ownerUserIds) : undefined,
  };
  // Build a real PrimitiveActorContext from the session and forward the
  // InstallActorRoleBag's resolved tiers as `roleHintsOverride`. Without this,
  // the kernel's user-owner short-circuit could not fire for project-target
  // installs by the project owner, leaving product-authz as the only working
  // gate.
  const kernelActor = actorFromSession(session);
  const roleHints: ActorRoleHints = {
    platformRole: actor.platformRole,
    orgRole: actor.orgRole,
    teamRoles: actor.teamRoles,
    actorOrganizationId: actor.organizationId,
  };
  try {
    await enforceResourceAccess(installRef, kernelActor, "registry.install", roleHints);
  } catch (err) {
    writeAuditDenied();
    throw err;
  }

  // Step 6 — resolve install environment.
  // Thread the explicit version so the gatekept-install path (when enabled)
  // authorizes the EXACT listed version instead of "latest" (avoids grant/install
  // drift + broker packument-filter misses). Ignored on the legacy flag-OFF path.
  let installConfig: VerdaccioConfig;
  try {
    const installEnv = await resolveInstallEnvironment(
      parsed.packageName,
      parsed.packageVersion,
    );
    const authTokenArg = installEnv.args.find((a) => a.includes(":_authToken="));
    const token = authTokenArg ? authTokenArg.split(":_authToken=")[1] : null;
    if (!token) {
      throw new Error(
        `[resolveInstallEnvironment] No _authToken arg found in install args for ${parsed.packageName}`,
      );
    }
    // packageScope is keyed on the PACKAGE BEING INSTALLED, never on the
    // instance identity (a publish-time concept) — instance-keyed install
    // scoping broke first-party installs on any instance whose namespace
    // isn't "cinatra-ai" (issue #103). The dependency-scope gate derives its
    // allowlist from the root package name inside
    // installAgentPackageWithDependencies; this field is informational
    // install plumbing (registryUrl + token carry the routing/auth).
    installConfig = {
      registryUrl: installEnv.registryUrl,
      packageScope: vendorScopeOfPackage(parsed.packageName) ?? FIRST_PARTY_PACKAGE_SCOPE,
      token,
      uiUrl: installEnv.registryUrl,
    };
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      throw new Error(INSTANCE_NAMESPACE_FAILURE_MESSAGE);
    }
    throw e;
  }

  // Step 7 — full-tree installer threads owner tier.
  await installAgentPackageWithDependencies(
    {
      packageName: parsed.packageName,
      packageVersion: parsed.packageVersion,
      orgId,
      creatorId: session.user.id,
      ownerLevel: parsed.target.level,
      ownerId: parsed.target.id,
      status: "published",
    },
    installConfig,
  );

  // Step 8 — allowed audit row (POLICY_VERSION + targetScope metadata).
  void logAuditEvent({
    organizationId: orgId,
    actorPrincipalId: session.user.id,
    actorPrincipalType: "human",
    authSource: "ui",
    resourceType: "registry_package",
    resourceId: parsed.packageName,
    operation: "install",
    decision: "allowed",
    policyVersion: POLICY_VERSION,
    metadata: { targetScope: { level: parsed.target.level, id: parsed.target.id } },
  });

  // Step 9 — Post-install dispatch. Kept identical to installRegistryPackage
  // dispatch behavior.
  const dest = parsed.destination ?? "extensions";
  if (dest === "run") redirect(buildAgentWorkspacePath(parsed.packageName));
  if (dest === "builder") redirect("/agents");
  redirect("/configuration/extensions");
}

// ---------------------------------------------------------------------------
// Back-compat wrapper. Existing call sites pass
// { packageName, packageVersion?, destination? } and expect Promise<void>;
// the wrapper delegates to installRegistryPackageAtScope with
// target = { level: "organization", id: <activeOrgId> } so behavior is
// preserved exactly.
//
// Session is fetched twice (here AND inside installRegistryPackageAtScope).
// This is acceptable cost; refactoring would require changing the inner
// action's signature and break contract testability. Audit-spy assertions
// in install-registry-at-scope-authz.test.ts assert exactly 1 logAuditEvent
// call per server action invocation (the wrapper does NOT write its own
// audit row; only the inner action does).
// ---------------------------------------------------------------------------
export async function installRegistryPackage(input: {
  packageName: string;
  packageVersion?: string;
  destination?: "builder" | "run" | "extensions";
}): Promise<void> {
  "use server";
  const session = await requireAuthSession();
  const orgId = getActiveOrganizationId(session);
  if (!orgId) {
    throw new Error(
      "No active organization — select one before installing a package.",
    );
  }
  return installRegistryPackageAtScope({
    ...input,
    target: { level: "organization", id: orgId },
  });
}

// ---------------------------------------------------------------------------
// updateRegistryPackage
//
// Upgrades an already-installed @cinatra/* package in place (no new
// agent_templates row — installAgentFromPackage's upsert branch handles that).
// No-ops when the target version equals the currently installed version.
// ---------------------------------------------------------------------------

export async function updateRegistryPackage(input: {
  packageName: string;
  packageVersion?: string;
}): Promise<void> {
  "use server";
  const parsed = makeUpdateRegistryInputSchema().parse(input);
  const session = await requireAuthSession();
  const orgId = getActiveOrganizationId(session);

  // Read the existing template FIRST so canDo() receives a ResourceRef scoped
  // to the row's owning org. Without this the kernel synthesizes a sentinel
  // scoped to the actor's own org and the cross-org guard never fires, letting
  // an org_admin in org A update a row owned by org B by passing the foreign
  // packageName directly.
  const existing = await readAgentTemplateByPackageName(parsed.packageName);
  if (!existing) {
    throw new Error(`Cannot update — package not installed: ${parsed.packageName}`);
  }

  // Same auth gate as installRegistryPackage.
  //
  // For the canDo cross-org guard to fire we need the row's owning org. Rows
  // without orgId fall back to the actor's active org so the predicate
  // evaluates like the sentinel-ref behavior. Tenant-attributed rows enforce
  // the cross-org guard.
  const opts = await buildCanDoOptsFromSession(session);
  const updateRef: ResourceRef = {
    resourceType: "registry",
    resourceId: existing.id,
    organizationId: existing.orgId ?? orgId,
  };
  if (!canDo(session, "registry.update", updateRef, opts)) {
    void logAuditEvent({
      organizationId: orgId,
      actorPrincipalId: session.user.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "registry_package",
      resourceId: parsed.packageName,
      operation: "update",
      decision: "denied",
      policyVersion: POLICY_VERSION,
      metadata: { templateId: existing.id, templateOrgId: existing.orgId ?? null },
    });
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Not authorized to update ${parsed.packageName}`,
    });
  }
  void logAuditEvent({
    organizationId: orgId,
    actorPrincipalId: session.user.id,
    actorPrincipalType: "human",
    authSource: "ui",
    resourceType: "registry_package",
    resourceId: parsed.packageName,
    operation: "update",
    decision: "allowed",
    policyVersion: POLICY_VERSION,
    metadata: { templateId: existing.id, templateOrgId: existing.orgId ?? null },
  });

  // Idempotent no-op when target version equals installed version.
  // Short-circuits before any tarball extract or DB write.
  if (parsed.packageVersion && existing.packageVersion === parsed.packageVersion) {
    redirect("/configuration/extensions");
  }

  // Route update through resolveInstallEnvironment.
  // Auth gate ran above. Resolver reads extension origin to determine which registry
  // (public vs private) and which CLI flags to use (topology A vs topology B).
  let updateConfig: VerdaccioConfig;
  try {
    // Thread the explicit target version so the gatekept-install path (when
    // enabled) authorizes the EXACT listed version instead of "latest". Ignored
    // on the legacy flag-OFF path.
    const updateEnv = await resolveInstallEnvironment(
      parsed.packageName,
      parsed.packageVersion,
    );
    const authTokenArgU = updateEnv.args.find((a) => a.includes(":_authToken="));
    const updateToken = authTokenArgU ? authTokenArgU.split(":_authToken=")[1] : null;
    // Explicit null guard so downstream registry client never makes an
    // unauthenticated request without a valid auth token.
    // routingMode is always "scope-based" | "shared-acl" (never "public") per
    // DeploymentRegistryConfig; throw unconditionally when token extraction fails.
    if (!updateToken) {
      throw new Error(
        `[resolveInstallEnvironment] No _authToken arg found in update args for ${parsed.packageName}`,
      );
    }
    // Same rule as the install path: packageScope is keyed on the PACKAGE
    // BEING UPDATED, never on the instance identity — updates run through the
    // same dependency-scope gate and hit the same issue #103 failure when
    // keyed on the instance namespace.
    updateConfig = {
      registryUrl: updateEnv.registryUrl,
      packageScope: vendorScopeOfPackage(parsed.packageName) ?? FIRST_PARTY_PACKAGE_SCOPE,
      token: updateToken,
      uiUrl: updateEnv.registryUrl,
    };
  } catch (e) {
    if (e instanceof InstanceNamespaceNotConfiguredError) {
      throw new Error(INSTANCE_NAMESPACE_FAILURE_MESSAGE);
    }
    throw e;
  }

  await installAgentPackageWithDependencies(
    {
      packageName: parsed.packageName,
      packageVersion: parsed.packageVersion,
      orgId,
      creatorId: session.user.id,
      status: existing.status === "published" ? "published" : "draft",
    },
    updateConfig,
  );

  redirect("/configuration/extensions");
}

// ---------------------------------------------------------------------------
// uninstallRegistryPackage.
//
// Admin-only server action that removes an installed agent_templates row.
// Defense-in-depth template-id check guards against parameter forgery
// by requiring both packageName and templateId to match the same row.
// ---------------------------------------------------------------------------

function makeUninstallRegistryInputSchema() {
  return z.object({
    packageName: makeAgentPackageNameSchema(),
    templateId: z.string().uuid(),
  });
}

export async function uninstallRegistryPackage(input: {
  packageName: string;
  templateId: string;
}): Promise<void> {
  "use server";
  const parsed = makeUninstallRegistryInputSchema().parse(input);
  const session = await requireAuthSession();
  const orgId = getActiveOrganizationId(session);

  // Two-pass authorization.
  //
  // Pass 1: coarse capability check against the actor's own org. Resource-less
  // canDo synthesizes a sentinel ref scoped to actor.organizationId — answers
  // "does this user have ANY uninstall capability in their own org?". Members
  // are denied here without leaking the existence of any specific template.
  const opts = await buildCanDoOptsFromSession(session);
  if (!canDo(session, "registry.uninstall", undefined, opts)) {
    void logAuditEvent({
      organizationId: orgId,
      actorPrincipalId: session.user.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "registry_package",
      resourceId: parsed.packageName,
      operation: "uninstall",
      decision: "denied",
      policyVersion: POLICY_VERSION,
      metadata: { templateId: parsed.templateId },
    });
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Not authorized to uninstall ${parsed.packageName}`,
    });
  }

  const existing = await readAgentTemplateByPackageName(parsed.packageName);
  if (!existing || existing.id !== parsed.templateId) {
    // Emit a `denied` audit event on the templateId-mismatch 404 path. Without
    // this, a directed enumeration attack against the templateId parameter is
    // invisible to ops because the canDo gate above already passed.
    void logAuditEvent({
      organizationId: orgId,
      actorPrincipalId: session.user.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "registry_package",
      resourceId: parsed.packageName,
      operation: "uninstall",
      decision: "denied",
      policyVersion: POLICY_VERSION,
      metadata: {
        reason: existing ? "templateId_mismatch" : "template_not_found",
        templateId: parsed.templateId,
        actualTemplateId: existing?.id ?? null,
      },
    });
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Template not found",
    });
  }

  // Pass 2: re-check canDo with an explicit ResourceRef scoped to the row's
  // owning org. The kernel's cross-org guard fires here for any actor whose
  // organizationId differs from the row's organizationId and who is not a
  // platform_admin. Without this, an org_admin of org A could uninstall a
  // template owned by org B by passing the foreign packageName + matching
  // templateId.
  //
  // Rows without orgId fall back to the actor's active org so the predicate
  // evaluates like the sentinel-ref behavior. Tenant-attributed rows enforce
  // the cross-org guard.
  const uninstallRef: ResourceRef = {
    resourceType: "registry",
    resourceId: existing.id,
    organizationId: existing.orgId ?? orgId,
  };
  if (!canDo(session, "registry.uninstall", uninstallRef, opts)) {
    void logAuditEvent({
      organizationId: orgId,
      actorPrincipalId: session.user.id,
      actorPrincipalType: "human",
      authSource: "ui",
      resourceType: "registry_package",
      resourceId: parsed.packageName,
      operation: "uninstall",
      decision: "denied",
      policyVersion: POLICY_VERSION,
      metadata: {
        reason: "cross_org",
        templateId: parsed.templateId,
        templateOrgId: existing.orgId ?? null,
      },
    });
    // Surface as 404 (not 403) so the response is indistinguishable from
    // "template does not exist" — same hidden-existence semantics as the
    // mismatch path above.
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Template not found",
    });
  }

  const deleted = await deleteAgentTemplate(parsed.templateId);

  void logAuditEvent({
    organizationId: orgId,
    actorPrincipalId: session.user.id,
    actorPrincipalType: "human",
    authSource: "ui",
    resourceType: "registry_package",
    resourceId: parsed.packageName,
    operation: "uninstall",
    decision: "allowed",
    policyVersion: POLICY_VERSION,
    metadata: {
      templateId: parsed.templateId,
      templateOrgId: existing.orgId ?? null,
      deleted,
    },
  });

  redirect("/configuration/extensions");
}

// forkRegistryEntry — server action

export async function forkRegistryEntry(entryId: string): Promise<void> {
  "use server";
  const session = await requireAuthSession();
  const userId = session.user.id;
  const isAdmin = isPlatformAdmin(session);

  const entry = await readRegistryEntryById(entryId);
  if (!entry) throw new Error("Registry entry not found");

  const canRun = await checkRegistryPermission(entryId, userId, isAdmin, "canRun");
  if (!canRun) throw new Error("Not authorized to fork");

  // Load the pinned version snapshot from the registry entry
  const version = await readAgentVersionById(entry.versionId);
  if (!version) throw new Error("Version snapshot not found");

  const snapshot = version.snapshot;
  const sourceNl = (snapshot.sourceNl ?? "") as string;
  const compiledPlan = (snapshot.compiledPlan ?? []) as CompiledStep[];
  const inputSchema = (snapshot.inputSchema ?? {}) as Record<string, unknown>;
  const outputSchema = (snapshot.outputSchema ?? null) as Record<string, unknown> | null;
  const approvalPolicy = (snapshot.approvalPolicy ?? { steps: [] }) as { steps: Array<{ stepNumber: number; riskClass: string; requiresApproval: boolean }> };

  const newTemplate = await createAgentTemplate({
    id: randomUUID(),
    orgId: undefined,
    creatorId: userId,
    name: "Fork of " + entry.title,
    description: entry.description ?? undefined,
    sourceNl,
    compiledPlan,
    inputSchema,
    outputSchema: outputSchema ?? undefined,
    approvalPolicy,
    status: "draft",
  });

  await createAgentVersion({
    id: randomUUID(),
    templateId: newTemplate.id,
    contentHash: version.contentHash,
    snapshot: version.snapshot,
  });

  await createAgentFork({
    registryEntryId: entryId,
    forkedTemplateId: newTemplate.id,
    forkedBy: userId,
  });

  redirect("/agents");
}

// runFromRegistry — server action

export async function runFromRegistry(
  entryId: string,
  inputParams: Record<string, unknown>,
): Promise<void> {
  "use server";
  const session = await requireAuthSession();
  const userId = session.user.id;
  const isAdmin = isPlatformAdmin(session);

  // orgId is required at agent_runs insert time. Hard-fail here so this server
  // action surfaces a clean diagnostic rather than crashing inside the store.
  // `requireAuthSession` calls `ensureDefaultOrganizationMembership` so this
  // branch is defense-in-depth for deleted-org stale sessions, corrupt
  // better-auth state, or test mocks.
  const orgId = session.session?.activeOrganizationId;
  if (!orgId) {
    throw new Error(
      "runFromRegistry: no active organization for the current session",
    );
  }

  const entry = await readRegistryEntryById(entryId);
  if (!entry) throw new Error("Registry entry not found");

  const canRun = await checkRegistryPermission(entryId, userId, isAdmin, "canRun");
  if (!canRun) throw new Error("Not authorized to run");

  // Pin entry.versionId (not the latest version)
  const run = await createAgentRun({
    id: randomUUID(),
    templateId: entry.templateId,
    versionId: entry.versionId,
    runBy: userId,
    inputParams,
    orgId,
    // Registry server-action path is not chat-bound; there is no project
    // context to inherit. Project-scoped runs originate from the chat MCP path
    // (agent_run handler) or A2A.
    projectId: null,
  });

  await enqueueAgentRun(
    { runId: run.id },
    { jobId: run.id },
  );

  redirect("/agents");
}

// updateBindingPermission — server action

const VALID_PERMISSION_FIELDS = new Set([
  "canView",
  "canRun",
  "canEditDraft",
  "canPublish",
  "canApprove",
]);

export async function updateBindingPermission(formData: FormData): Promise<void> {
  "use server";
  await requireAdminSession();

  const id = formData.get("id") as string;
  const field = formData.get("field") as string;
  const value = formData.get("value") as string;

  if (!VALID_PERMISSION_FIELDS.has(field)) {
    throw new Error("Invalid permission field");
  }

  await updateShareBinding(id, { [field]: value === "true" });
}

// addShareBinding — server action

export async function addShareBinding(formData: FormData): Promise<void> {
  "use server";
  const session = await requireAdminSession();
  const grantedBy = session.user.id;

  const registryEntryId = formData.get("registryEntryId") as string;
  const subjectType = formData.get("subjectType") as string;
  const subjectId = formData.get("subjectId") as string;
  const canView = formData.get("canView") === "on";
  const canRun = formData.get("canRun") === "on";
  const canEditDraft = formData.get("canEditDraft") === "on";
  const canPublish = formData.get("canPublish") === "on";
  const canApprove = formData.get("canApprove") === "on";

  await createShareBinding({
    registryEntryId,
    subjectType,
    subjectId,
    canView,
    canRun,
    canEditDraft,
    canPublish,
    canApprove,
    grantedBy,
  });

  redirect("/configuration/extensions/permissions");
}

// recompileAgentTemplate — re-run the LLM compiler on the stored sourceNl

// compileWorkflow has a single branch — it emits taskSpec for the
// WayFlow runtime. executionProvider is passed to record provenance only
// (the dispatch path is unchanged regardless of input).
export async function recompileAgentTemplate(
  templateId: string,
): Promise<void> {
  "use server";
  const session = await requireAdminSession();

  const template = await readAgentTemplateById(templateId);
  if (!template) throw new Error("Agent template not found");

  const allHandlers = await collectAllPrimitiveHandlers();
  const toolNames = Object.keys(allHandlers);

  // NOTE: compileWorkflow may throw when the compiler's post-generation
  // validation rejects the LLM output (too-short or ungrounded taskSpec).
  // DO NOT catch here — let the error propagate to the calling form so the
  // user sees the message. redirect() is only reached on success.
  const result = await compileWorkflow(template.sourceNl, toolNames, {
    executionProvider: "wayflow",
  });

  const updated = await updateAgentTemplate(templateId, {
    taskSpec: result.taskSpec,
    lgGraphCode: null,   // clear any legacy Python code
    lgGraphId: null,     // type-based routing; no explicit id needed
    type: result.type,
    inputSchema: result.inputSchema,
    outputSchema: result.outputSchema,

    executionProvider: "wayflow",
    ioSpec: { input: result.inputSpec.input, output: result.outputSpec.output },
  });

  await createAgentVersion({
    id: randomUUID(),
    templateId,
    contentHash: createHash("sha256").update(result.taskSpec).digest("hex"),
    snapshot: {
      sourceNl: template.sourceNl,
      taskSpec: result.taskSpec,
      lgGraphCode: null,
      lgGraphId: null,
      inputSchema: result.inputSchema,
      outputSchema: result.outputSchema ?? null,

      executionProvider: "wayflow",
      type: result.type,
    },
  });

  if (updated) {
    await createAgentTemplateVersionIfChanged(updated, {
      changelogLine: `Recompiled (${result.type})`,
      // Patch override is intentional — the user explicitly triggered a recompile,
      // so any resulting type or taskSpec change is an expected side effect of the action,
      // not an independently-authored breaking change.
      bumpTypeOverride: "patch",
      createdBy: session?.user?.id ?? null,
    });
  }

  redirect("/agents");
}

// rollbackAgentTemplate — server action for UI-triggered rollback

export async function rollbackAgentTemplate(
  templateId: string,
  targetVersionId: string,
): Promise<{ ok: true; newVersionId: string } | { ok: false; error: string }> {
  "use server";
  try {
    const session = await requireAdminSession();
    const result = await rollbackAgentTemplateToVersion(
      templateId,
      targetVersionId,
      session?.user?.id ?? null,
    );
    return { ok: true, newVersionId: result.restoredVersionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

// importAgentTemplate lives in import-export-actions.ts
