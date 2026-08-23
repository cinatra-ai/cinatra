import "server-only";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  requireAuthSession,
  requireAdminSession,
  requireActorContext,
  buildCanDoOptsFromSession,
  isPlatformAdmin,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
// cinatra#1939 wave 2: rejectReviewTask mints a member SESSION authority for
// the setup-run→failed transition. Owner ruling 2026-07-26 (ruling 2) DROPPED
// cross-org run management: an actor cleared by the HITL run gate who is NOT
// a member of the run's org now fails closed here.
import { sessionAuthorityFromResolvedRole, verifySessionAuthority } from "@/lib/org-write/authority";
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
// cinatra#2485 item B: the HITL approve/reject server actions authorize the
// ACTOR against the RESOLVED RUN (run.execute + run.approveHitl) instead of
// demanding a platform-admin session. `resolveEffectivePolicy` is imported
// alongside so the reject-path probe carries a CONCRETE policy — a null policy
// makes `enforceRunAccess` skip the policy gate entirely, and the kernel's
// `member` role grants run.resume/run.approveHitl to every same-org member.
import { enforceRunAccess, resolveEffectivePolicy } from "./auth-policy";
// Install-target authorization gates — SHARED with the extension marketplace
// install action (packages/extensions/src/actions.ts). Moved verbatim to
// ./install-target-authz so the two paths enforce one rule grid.
import {
  assertCanInstallAtTarget,
  assertTargetBelongsToActiveOrg,
  readActorRolesForInstall,
} from "./install-target-authz";
import { buildAgentWorkspacePath } from "@/lib/agent-url";
import { enqueueAgentRun } from "@/lib/agent-run-enqueue";
import { approveReviewTaskInternal } from "./review-task-actions";
// cinatra#1061: close the agent-catalog removal-path gate bypass. The gate
// re-applies the dispatcher's system-extension + dependency-closure refusals
// before the direct agent_templates delete; the classifier maps the thrown
// refusal to the returned contract the production UI can render.
import { assertAgentTemplateRemovable } from "./removal-gate";
import {
  classifyRemovalFailure,
  type RemovalActionResult,
} from "@cinatra-ai/extensions/removal-failure";
import {
  createAuditEvent,
  deleteAgentTemplate,
  readAgentTemplateById,
  readAgentTemplateByPackageName,
  readAgentRunById,
  readRunCoOwners,
  readAgentVersionsByTemplate,
  readAgentVersionById,
  createAgentTemplate,
  createAgentVersion,
  createShareBinding,
  createAgentFork,
  checkRegistryPermission,
  readRegistryEntryById,
  updateAgentTemplate,
  updateShareBinding,
  createAgentTemplateVersionIfChanged,
  rollbackAgentTemplateToVersion,
  // The run-start path at the end of this file drives the canonical CAS itself.
  transitionRunStatus,
  RunTransitionError,
} from "./store";
import type {
  CompiledStep,
  AgentRunStatus,
  AgentRunRecord,
  AgentTemplateRecord,
  CreateAgentRunInput,
} from "./store";
import { launchAgentRun } from "./lifecycle-coordinator";
import type { AgentRunEnqueueOptions } from "@/lib/agent-run-enqueue";
import { resolveRunCreationAuthority } from "@/lib/org-write/run-creation-authority";
import { compileWorkflow } from "./compiler";
import { collectAllPrimitiveHandlers } from "@/lib/primitive-handlers";
import { publishAgentPackage } from "./verdaccio/client";
import { installAgentPackageWithDependencies } from "./install-package-with-dependencies";
// cinatra#2616 — the identity claim guarding the package-name-keyed origin write.
import { claimOfAuthorizedTemplate } from "./agent-template-identity";
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

// ---------------------------------------------------------------------------
// HITL actor resolution (cinatra#2485 item B)
//
// The UI HITL entry points (`approveReviewTask` / `rejectReviewTask`) used to
// gate on `requireAdminSession()`. That made the per-step HITL wait
// (setup-input collection and the mid-run WayFlow / artifact-review interrupts)
// undriveable by the very member who started the run: a non-platform-admin
// initiator could not submit the required setup input at all, so the run sat in
// `pending_approval` forever. Advancing a gate on your OWN run is not a
// platform-administration act — it is part of running the agent.
//
// The replacement is ACTOR-AWARE authorization, not "no authorization": the
// session is turned into a VERIFIED actor context + role hints, and the run
// itself is the authority (`run.execute` + `run.approveHitl`), exactly as the
// A2A resume route already does (`review-task-actions.ts` enforceResumeAccess).
//
// ⚠️ The trap this helper exists to make unmissable: `approveReviewTaskInternal`
// SKIPS its run-access gate entirely when `actorContext` is absent
// (review-task-actions.ts — `if (!actorContext) return;`). Swapping
// `requireAdminSession()` for `requireAuthSession()` WITHOUT threading an
// actorContext would therefore hand every authenticated user unauthenticated
// authority over every run. Both entry points go through this helper and both
// ALWAYS pass the actorContext through; the regression tests pin that.
// ---------------------------------------------------------------------------
type HitlActor = {
  userId: string;
  actorContext: ReturnType<typeof actorFromSession>;
  roleHints: ActorRoleHints;
};

async function requireHitlActor(): Promise<HitlActor> {
  const session = await requireAuthSession();
  // The kernel context resolves the caller's org role, team memberships +
  // team roles, and project grants in the session lineage. Those axes are what
  // let a non-admin member reach their own run through `enforceRunAccess`
  // without a platform-admin standing. Mirrors
  // `confirmRunSkillSelectionAction` (server-actions.ts), the existing
  // session-backed run-access call site.
  const kernel = await requireActorContext();
  const roleHints: ActorRoleHints = {
    ...(kernel.platformRole ? { platformRole: kernel.platformRole } : {}),
    ...(kernel.orgRole ? { orgRole: kernel.orgRole } : {}),
    ...(kernel.teamRoles ? { teamRoles: kernel.teamRoles } : {}),
    ...(kernel.teamIds ? { teamIds: kernel.teamIds } : {}),
    ...(kernel.projectGrants ? { projectGrants: kernel.projectGrants } : {}),
    // The actor's ACTIVE org, never run.orgId — `enforceRunAccess` only derives
    // an org role when the caller declares the org it is already acting in, so
    // sourcing it from the run would weaken the cross-org guard.
    actorOrganizationId: kernel.organizationId ?? null,
  };
  return {
    userId: session.user.id,
    actorContext: actorFromSession(session),
    roleHints,
  };
}

/**
 * Authorize a HITL actor against a RESOLVED run: `execute` THEN `approveHitl`,
 * the exact order and pair `agent_run_resume` and the A2A resume seam use.
 *
 * `run === null` is handed to `enforceRunAccess` deliberately — it raises the
 * kernel's 404-shaped AuthzError, so a MISSING run and a run this actor may not
 * touch are not distinguished by the DETAIL of the error text (the kernel's
 * documented contract still separates 404-hidden from 403-forbidden; see the
 * `enforceRunAccess` header). The point here is ordering: the gate runs BEFORE
 * this action's own `run <id> not found` message, which would otherwise confirm
 * a foreign run id's absence to an unauthorized caller.
 *
 * The probe carries a CONCRETE effective policy via `resolveEffectivePolicy`
 * (owner-only `DEFAULT_AGENT_AUTH_POLICY` when neither run nor template
 * declares one). A bare `?? null` would leave `run.effectivePolicy` falsy and
 * `enforceRunAccess` then SKIPS the policy gate — and the authorization
 * kernel's `member` role grants BOTH `run.resume` and `run.approveHitl`, so
 * every same-org member would be able to drive a stranger's run. Same reasoning
 * as `confirmRunSkillSelectionAction` (server-actions.ts) and `readAgentRunById`.
 */
async function enforceHitlRunAccess(
  run: Awaited<ReturnType<typeof readAgentRunById>>,
  actor: HitlActor,
): Promise<void> {
  const template = run?.templateId ? await readAgentTemplateById(run.templateId) : null;
  const coOwnerRows = run ? await readRunCoOwners(run.id) : [];
  const runForCheck = run
    ? {
        id: run.id,
        runBy: run.runBy,
        orgId: run.orgId,
        effectivePolicy: resolveEffectivePolicy(run, template),
        coOwnerUserIds: coOwnerRows.map((r) => r.userId),
      }
    : null;
  await enforceRunAccess(runForCheck, actor.actorContext, "execute", actor.roleHints);
  await enforceRunAccess(runForCheck, actor.actorContext, "approveHitl", actor.roleHints);
}

// approveReviewTask

export async function approveReviewTask(
  taskId: string,
  values?: unknown,
  fieldName?: string,
  schemaSnapshot?: Record<string, unknown> | null,
): Promise<void> {
  "use server";
  // Core logic lives in approveReviewTaskInternal so the external
  // /api/a2a/resume route can call it with Bearer JWT auth. Both entry points
  // now authorize the SAME way: a verified actor context is threaded in and the
  // helper enforces run.execute + run.approveHitl against the run it resolves,
  // BEFORE any state-changing write, on both the setup-* and wayflow-* branches.
  //
  // cinatra#2485 item A: the run-side separation-of-duties self-approval guard
  // (#563) and its `connector_config.agent_run.allowSelfApproval` escape hatch
  // are GONE. Install/later-set scope is the run-authorization gate; a member
  // clearing a gate on a run they started is running the agent, not
  // rubber-stamping a governance decision. (`agent_creation.allowSelfApproval`
  // is a DIFFERENT setting on the agent-publication path and is untouched.)
  //
  // cinatra#2485 item B: `requireAdminSession()` is GONE from this path. It made
  // the per-step HITL wait undriveable by a non-admin initiator — the run sat in
  // pending_approval forever, which together with the SoD guard above was the
  // observed deadlock.
  //
  // `values` is forwarded so setup-field interrupts can merge into
  // agent_runs.inputParams atomically with the approval status flip (one CAS
  // UPDATE — see approveReviewTaskInternal, #76).
  //
  // `fieldName` is forwarded so setup paths can bypass the provenance read.
  // Default undefined preserves back-compat for all current callers.
  const actor = await requireHitlActor();

  // cinatra#1796 / #2047 row 8: the legacy auditor SoD APPROVAL-RECEIPT mint was
  // REMOVED with the retirement teardown. It wrote an approval-bearing row
  // (auditor_approval_receipts) outside the gate store — the "parallel decision
  // path" row 8 forbids — and its only consumer, /api/auditor/apply, is gone.
  // Approval on this surface is recorded solely by the gate store and its
  // gate-anchored S4 child (suggestion_decision_ledger).

  // The trailing actorContext + roleHints are NOT optional here: without them
  // approveReviewTaskInternal skips its run-access gate and this action would be
  // an unauthenticated-authority hole for every authenticated user. The run
  // resolution (including the wayflow- Redis reverse-map fallback) stays inside
  // the helper, so the gate and the mutation observe ONE resolution — there is
  // no check-time/use-time window for a second resolver to disagree with.
  await approveReviewTaskInternal(
    taskId,
    actor.userId,
    values,
    fieldName,
    schemaSnapshot,
    actor.actorContext,
    actor.roleHints,
  );
}

// rejectReviewTask

export async function rejectReviewTask(taskId: string, reason?: string): Promise<void> {
  "use server";
  // cinatra#2485 item B: same re-authorization as approveReviewTask. Declining a
  // gate is the other half of driving it, so it carries the SAME authority
  // (run.execute + run.approveHitl on the resolved run) rather than a
  // platform-admin session. Unlike the approve path this action owns its own run
  // resolution + mutation (there is no shared internal helper for reject), so the
  // gate is applied HERE, before the existence error and before the transition.
  const actor = await requireHitlActor();

  // ---------------------------------------------------------------------------
  // review_tasks table is gone. Real-UUID reject paths are no longer supported.
  // setup- prefix: mark run as failed directly.
  // ---------------------------------------------------------------------------
  if (taskId.startsWith("setup-")) {
    const runId = taskId.slice("setup-".length);
    const run = await readAgentRunById(runId);
    // Gate the resolved run BEFORE the existence-revealing error and before the
    // status transition. A null run raises the kernel's 404-shaped AuthzError
    // inside enforceRunAccess, so an unauthorized caller never reaches the
    // `run <id> not found` message below.
    await enforceHitlRunAccess(run, actor);
    if (!run) throw new Error(`[rejectReviewTask] run ${runId} not found`);
    // Ground the setup-run→failed transition on the acting principal's member
    // SESSION authority. Owner ruling 2026-07-26 (ruling 2): cross-org run
    // management is unsupported, so an authorized actor who is NOT a member
    // of the run's org fails closed here rather than driving the run.
    const role = await resolveOrgRoleForUser(run.orgId, actor.userId);
    if (role === undefined) {
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message:
          `[rejectReviewTask] actor ${actor.userId} is not a member of org ${run.orgId}; ` +
          `cross-org run management is unsupported`,
      });
    }
    const authority = sessionAuthorityFromResolvedRole(run.orgId, role);
    const { transitionRunStatus, RunTransitionError } = await import("./store");
    await transitionRunStatus(runId, run.status as AgentRunStatus, "failed", undefined, authority).catch((err) => {
      if (err instanceof RunTransitionError && err.code === "stale_from_status") {
        // Race: another path terminated this run between our read and the CAS.
        // Safe to ignore — the run is terminal either way.
        return;
      }
      throw err;
    });
    console.log(`[rejectReviewTask] setup-path rejected run=${runId} actor=${actor.userId} reason=${reason ?? "(none)"}`);
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
        // cinatra#2616 — the claim of the row this action already resolved and
        // authorized. package_name is globally unique, so it pins the write to
        // that identity and refuses if the identity moved to another org.
      }, claimOfAuthorizedTemplate(template, orgId));
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

// (assertCanInstallAtTarget / assertTargetBelongsToActiveOrg /
// readActorRolesForInstall moved VERBATIM to ./install-target-authz — shared
// with the extension marketplace install action. Rule grid + tenant-validation
// semantics unchanged; the matrix tests in
// __tests__/install-registry-at-scope-authz.test.ts still lock them via this
// action.)

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
      // cinatra#1039 decision 3: the actor role bag rides along so a planned
      // dedupe-upward of a shared dependency row OWNED AT A DIFFERENT SCOPE is
      // re-authorized against THAT row's exact scope (same rule grid as steps
      // 4a/4b). Without it, cross-scope mutation is fail-closed.
      actor,
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

  // cinatra#1039: plan the update at the ROW's REAL ownership tuple — the
  // template row carries the install-time owner tier AND owning org; without
  // them a team/project-owned (or foreign-org) root would plan and
  // dedupe-classify as owned by the actor's active org. Re-supplying the SAME
  // owner tier/org is an explicit no-op in updateAgentTemplate (only a CHANGE
  // trips the reassignment gate); a row with no org keeps the pre-existing
  // active-org stamping. agent_templates.owner_level never carries "platform"
  // (it is stamped only from InstallScopeTarget / import paths), so the
  // five-level union below is exhaustive for this table. The actor role bag
  // rides along for the decision-3 re-authorization of any dependency-row
  // mutation (with an actor present the authorizer ALWAYS re-runs the grid
  // against the existing row's exact scope — this action's own gate is the
  // generic registry.update canDo, not the scope grid).
  const existingOwnerLevel = (
    ["user", "team", "organization", "workspace", "project"] as const
  ).find((l) => l === existing.ownerLevel);
  const planOrgId = existing.orgId ?? orgId;
  await installAgentPackageWithDependencies(
    {
      packageName: parsed.packageName,
      packageVersion: parsed.packageVersion,
      orgId: planOrgId,
      creatorId: session.user.id,
      status: existing.status === "published" ? "published" : "draft",
      // cinatra#2485 C — the existing row's anchors are forwarded AS THEY ARE,
      // including a half-anchor (a narrow `owner_level` whose `owner_id` is
      // null on a legacy row). Dropping the half-anchor here would be WORSE
      // than forwarding it: with neither anchor present the canonical ORG
      // DEFAULT applies, which would silently re-stamp a personal/team agent
      // — and its dependency rows — as org-wide. So the partial travels to
      // `withDeterminateInstallScope`, which refuses it at the write boundary.
      // A corrupt row fails LOUDLY; it is never widened and never guessed at.
      ...(existingOwnerLevel
        ? { ownerLevel: existingOwnerLevel, ...(existing.ownerId ? { ownerId: existing.ownerId } : {}) }
        : {}),
      ...(orgId ? { actor: readActorRolesForInstall(session, orgId, opts.orgRole) } : {}),
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
}): Promise<RemovalActionResult | void> {
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

  // cinatra#1061: close the removal-path gate bypass. This direct
  // agent_templates delete never went through the extension dispatcher, so it
  // skipped BOTH the #1036 system-extension protection AND the dependency-closure
  // gate. Re-apply them here — AFTER authorization (a failed authz check must
  // keep its hidden-existence 404, so those THROW above), BEFORE the delete.
  // RETURN the classified refusal instead of throwing: a thrown server-action
  // error is masked by Next.js in production, so the dependents/system message
  // would never reach the user (the exact bug #1061 fixes). The raw detail stays
  // operator-side (logs); a `denied` audit row records the refusal.
  try {
    await assertAgentTemplateRemovable(parsed.packageName);
  } catch (err) {
    const failure = classifyRemovalFailure(err);
    console.error(
      "[registry-uninstall] refused for %s (reason=%s):",
      parsed.packageName,
      failure.reason,
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
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
        reason: `removal_gate:${failure.reason}`,
        templateId: parsed.templateId,
        templateOrgId: existing.orgId ?? null,
      },
    });
    return failure;
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

  // cinatra#1940 P3 (Decision 2): the creation perimeter is now guarded
  // (capability run.execute) — mint the member session authority for it.
  const authority = await verifySessionAuthority(userId, orgId);

  // Pin entry.versionId (not the latest version).
  //
  // Routed through the coordinator (cinatra#2928): this is a person pressing Run
  // in the product, so it is an INTERACTIVE producer and says so — presence is
  // then derived from that claim together with the session user this action
  // already resolved, and the run may reach the recommendation moment exactly as
  // the same act from a conversation does.
  const runId = randomUUID();
  // The template the moment is decided against — its manifest lifecycle is what
  // says whether a recommendation applies at all.
  const entryTemplate = await readAgentTemplateById(entry.templateId);
  await launchAgentRun({
    producer: "registry_run_action",
    frame: { userId },
    interactive: true,
    create: {
      kind: "full",
      input: {
        id: runId,
        templateId: entry.templateId,
        versionId: entry.versionId,
        runBy: userId,
        inputParams,
        orgId,
        // Registry server-action path is not chat-bound; there is no project
        // context to inherit. Project-scoped runs originate from the chat MCP path
        // (agent_run handler) or A2A.
        projectId: null,
      },
    },
    template: {
      packageName: entryTemplate?.packageName ?? "",
      lifecycleConfig: entryTemplate?.lifecycleConfig ?? null,
    },
    authority,
    dispatch: { kind: "enqueue", options: { jobId: runId } },
  });

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

// ---------------------------------------------------------------------------
// THE RUN-START PATH THAT CONSULTS THE HOLD
// ---------------------------------------------------------------------------
//
// Placed in THIS module rather than a new one, and the two constraints that
// pick the home also agree with each other. `createAgentRun` and
// `transitionRunStatus` sit inside the org-write perimeter, whose registry
// enumerates their legitimate callers — this file is already one of them, and a
// new importer is a reviewed design event, not something a slice decides on the
// way past. The locked dev-perf routes are budget-pinned on reachable
// first-party module count, so a new file would have raised four ceilings.
// This module already owns a create-and-enqueue run-start (`runFromRegistry`
// below); the sequence here is the same act, generalized over the launch frame.
//
// PART 1 — the SERVER-DERIVED chat launch origin for the `agent_run` primitive.
//
// `agent_run` is reachable from several launch frames, and only one of them is
// a person sitting in a conversation. That difference decides whether the run
// is human-present, and therefore whether it may PAUSE on a lifecycle hold
// instead of dispatching straight into the queue.
//
// The rule `isChatLaunchFrame` exists to enforce is that the answer comes from
// the verified call frame and NEVER from the call's arguments. A primitive's input
// is model-authored; if presence were readable from there, any agent could
// claim a human was watching (or deny that one was) and choose its own
// supervision. So this function reads two fields, and both of them are stamped
// exclusively by server-only code the model cannot reach:
//
//   • `delegatedRestricted` — the REMOTE MCP carrier. The transport resolves it
//     from the delegated actor it verified (`delegation === "chat"`), writes it
//     into the request context, and the agents registry forwards it onto the
//     model actor. No second remote claim is minted here on purpose: one
//     verified carrier per path is the whole design, and a parallel one would
//     only add a thing to forge.
//   • `launchOrigin` — the IN-PROCESS carrier, for the chat pre-router, which
//     builds no delegated actor at all and so has no `delegatedRestricted` to
//     read. Stamped in exactly one place: the chat dispatch boundary's
//     `chatActorToPrimitive`, as a constant.
//
// Everything else — an OBO / agent-as-tool child dispatch, a scheduler fire, an
// A2A call, a plain machine token — carries neither field and is headless, which
// is exactly the previous behaviour for those paths.
//
// Deliberately typed over a minimal structural shape rather than importing the
// actor type: it keeps the check honest (it can only look at these two fields)
// and unit-testable without constructing a transport frame.


/** The two server-stamped fields this decision may read. Nothing else. */
export type ChatLaunchOriginFrame = {
  /** Remote MCP: transport-verified `delegation === "chat"`. */
  readonly delegatedRestricted?: unknown;
  /** In-process chat pre-router: stamped by `chatActorToPrimitive`. */
  readonly launchOrigin?: unknown;
};

/**
 * True when the frame is a verified chat launch — a human started this run from
 * a conversation, so the run is human-present and may park on a hold.
 *
 * Fail-closed by construction: anything that is not one of the two exact
 * server-stamped values answers false (headless), which is the pre-existing
 * dispatch behaviour. A missing frame is headless.
 */
export function isChatLaunchFrame(frame: unknown): boolean {
  if (!frame || typeof frame !== "object") return false;
  // Narrowed HERE and only here. The parameter is `unknown` so that every
  // caller hands over its whole actor envelope — whatever shape that transport
  // gives it — and this module remains the single place that decides which
  // fields the answer may come from.
  const { delegatedRestricted, launchOrigin } = frame as ChatLaunchOriginFrame;
  // Strict equality on both, so a truthy-but-wrong value (the string "false",
  // an object, a 1) cannot widen the check.
  if (delegatedRestricted === true) return true;
  return launchOrigin === "chat";
}

//
// PART 2 — the `agent_run` CREATE → DECIDE → DISPATCH sequence.
//
// Held out of the primitive hub because it is one decision with three possible
// endings, and reading it as one piece is the only way to see that the endings
// are exhaustive and that each one reports itself honestly.
//
// `agent_run` serves two kinds of caller. A headless one — an OBO / agent-as-tool
// child dispatch, a scheduler fire, an A2A call — wants creation and dispatch to
// be the same act, and gets exactly that. A CHAT caller is a person who just
// asked for something in a conversation, and their run may need to stop and ask
// before it starts: the run-start recommendation hold.
//
// THE ORDERING IS THE WHOLE POINT. A chat-started run is created `pending_input`
// and dispatched only after the hold declines to fire. The tempting shape —
// create it `queued` as always, then hold it — STRANDS the run: Confirm and Skip
// release only the two pre-dispatch waiting states, so a hold applied to an
// already-queued row is a hold nothing can ever let go of.
//
// Three endings, and the status returned is always the one the row is really in:
//   HELD      → `pending_input`, nothing enqueued, waiting on a person.
//   DISPATCHED→ `queued`, CAS'd once and enqueued once.
//   RACED     → someone else moved the run first; this call adds no second job
//               and claims no state it did not produce.
//
// An enqueue failure THROWS after reverting this function's own CAS, so no
// caller can ever be handed a `queued` result for a run with no job behind it.


/** The creation inputs the caller owns. Presence and initial status are NOT
 *  among them: this module derives both from the launch frame, so no caller can
 *  hand in a presence claim. */
export type LaunchFrameCreateInput = Omit<
  CreateAgentRunInput,
  "initialStatus" | "humanPresent"
>;

export type LaunchedRun = {
  run: AgentRunRecord;
  /** The status this call actually produced — never an optimistic one. */
  status: string;
  /** True when the run parked on the hold and is waiting on a human decision. */
  held: boolean;
};

/**
 * The `agent_run` primitive's run-start, now a THIN CALL onto the lifecycle
 * coordinator (cinatra#2928, epic #2926 W2a).
 *
 * The create-parked → evaluate → release-or-park sequence this function used to
 * carry — and which `run-actions.ts` carried a second copy of — lives in
 * `launchAgentRun` (`./lifecycle-coordinator`), which generalizes it over every
 * producer and, on the way, states the moment the run is waiting at on the run
 * itself. `scripts/audit/run-creation-fence.mjs` is what keeps it the only
 * creator; this wrapper stays because the primitive's caller wants the
 * `held` reading rather than the coordinator's moment.
 *
 * The PRESENCE rule changed with the move, and deliberately. It used to be "the
 * frame came through a chat surface", which the chat pre-router stamps as a
 * constant — so a non-human principal reaching that pre-router produced a run
 * stamped human-present with no owner (cinatra#2892). Presence now needs the
 * verified surface AND a resolvable human owner; `isChatLaunchFrame` above is
 * still the surface half, and the coordinator holds both.
 */
export async function createAgentRunForLaunchFrame(input: {
  /** The VERIFIED actor envelope. */
  frame: unknown;
  create: LaunchFrameCreateInput;
  template: Pick<AgentTemplateRecord, "packageName"> & { lifecycleConfig?: string | null };
  enqueueOptions: AgentRunEnqueueOptions;
}): Promise<LaunchedRun> {
  const answer = await launchAgentRun({
    producer: "chat_or_widget_dispatch",
    frame: input.frame,
    create: { kind: "full", input: input.create },
    template: input.template,
    dispatch: { kind: "enqueue", options: input.enqueueOptions },
  });
  return {
    run: answer.carrier.kind === "run" ? answer.carrier.run : (() => {
      // Unreachable: `launchAgentRun` answers with a run carrier for every
      // launch. Stated as a throw rather than a cast so a future carrier cannot
      // be silently mis-read as a run.
      throw new Error("the launch answered with a carrier that is not a run");
    })(),
    status: answer.status,
    held: answer.moment === "recommendation",
  };
}
