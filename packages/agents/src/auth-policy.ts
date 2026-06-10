/**
 * AgentAuthPolicy framework.
 *
 * Single source of truth for the AgentAuthPolicy contract and the bridge
 * between the MCP envelope's `PrimitiveActorContext` and the authorization
 * kernel's `ActorContext`.
 *
 * Responsibility split:
 *   - This file translates MCP actor + run inputs into the kernel's
 *     ActorContext + ResourceRef shape and asks `can()` to decide.
 *   - The authorization kernel (src/lib/authz) owns the allow/deny algorithm.
 *   - This file does NOT wrap can() in try/catch — kernel exceptions
 *     propagate to the caller's existing error handling (fail-closed).
 *
 * Trust boundary: `actor.actorType` (especially "a2a") is set by the
 * calling route after token verification — see /api/a2a hardening in
 * the route layer. This file trusts the supplied actor.
 */
import "server-only";

import { can, AuthzError, POLICY_VERSION } from "@/lib/authz";
import type { ActorContext, Permission, ResourceRef } from "@/lib/authz";
import {
  enforceResourceAccess,
  type ResourceForAccessCheck,
} from "@/lib/authz/enforce-resource-access";
import type { PrimitiveActorContext } from "@cinatra-ai/mcp-client";
import {
  readTeamsForUser,
  readProjectGrantsForUser,
  type ProjectGrant,
} from "@/lib/better-auth-db";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";

// Client-safe types and schema live in auth-policy-types.ts so that client
// components can import them without pulling in this file's server-only guard.
export {
  AgentAuthPolicySchema,
  AgentAuthPolicyVisibilitySchema,
  DEFAULT_AGENT_AUTH_POLICY,
} from "./auth-policy-types";
export type { AgentAuthPolicy, AgentAuthPolicyVisibility } from "./auth-policy-types";
import { AgentAuthPolicySchema, DEFAULT_AGENT_AUTH_POLICY } from "./auth-policy-types";
import type { AgentAuthPolicy, AgentAuthPolicyVisibility } from "./auth-policy-types";

// ---------------------------------------------------------------------------
// Operation → Permission mapping
//
// This mapping covers all run-access operations. The HITL operations
// (approveHitl, respondToHitl, editOutput) are mapped here so any
// call site can
// enforce by passing the operation name without re-implementing the mapping.
//
// An exhaustive `switch` with a `never` default ensures that adding a
// variant to RunAccessOperation without a matching OPERATION_PERMISSION
// entry fails tsgo typecheck.
// ---------------------------------------------------------------------------

export type RunAccessOperation =
  | "list"
  | "read"
  | "execute"
  | "approveHitl"
  | "respondToHitl"
  | "editOutput"
  // cancel + share are reachable JWT scopes (Permission enum +
  // PERMISSION_SET in src/lib/authz/scope-map.ts both include them); without
  // a corresponding RunAccessOperation literal, a token holding scope
  // "run.cancel" cannot be intersected against any operation, and a future
  // cancel handler that forgets to call enforceRunAccess silently bypasses
  // the intersection. The exhaustive `never` guards in policyAllows + the
  // future cancel/share handlers force a downstream visibility-tier
  // decision once added here.
  | "cancel"
  | "share";

export const OPERATION_PERMISSION: Record<RunAccessOperation, Permission> = {
  list: "run.list",
  read: "run.read",
  execute: "run.resume",
  approveHitl: "run.approveHitl",
  respondToHitl: "run.respondToHitl",
  editOutput: "run.editOutput",
  cancel: "run.cancel",
  share: "run.share",
};

// ---------------------------------------------------------------------------
// Bridge: PrimitiveActorContext → ActorContext
//
// `buildActorContextFromPrimitive` and `ActorRoleHints` live in
// `src/lib/authz/build-actor-context.ts` so the generic
// `enforceResourceAccess` helper can build kernel actors
// without depending on this agent-builder package. The exports below are
// thin re-exports preserving back-compat for every existing call site.
// ---------------------------------------------------------------------------

import {
  buildActorContextFromPrimitive,
  type ActorRoleHints,
} from "@/lib/authz/build-actor-context";

export { buildActorContextFromPrimitive };
export type { ActorRoleHints };

// Resource-access helpers: requireResourceAccess, actorContextFromMcpRequest,
// buildScopeReason, and SkillResourceRef
// ---------------------------------------------------------------------------

/**
 * Resource reference used by requireResourceAccess.
 * `level` mirrors SkillLevel from @cinatra-ai/skills.
 * `ownerId` is the team UUID / project UUID / user UUID depending on level.
 */
export type SkillResourceRef = {
  resourceType: "skill" | "registry";
  resourceId: string;
  level?: string; // mirrors SkillLevel: "system"|"team"|"organization"|"workspace"|"project"|"personal"|"agent"
  visibility?: AgentAuthPolicyVisibility;
  organizationId?: string;
  ownerId?: string;
};

/**
 * Centralized helper that builds a `SkillResourceRef` from a stored skill
 * row. Passing `organizationId: callerOrgId` at every call site is
 * tautological with the `requireResourceAccess` org check
 * (`actor.organizationId === resource.organizationId`) and can let
 * cross-org reads of `level: "organization"` skills pass undetected.
 *
 * The correct shape:
 *   - For `level: "organization"` rows: `organizationId` is the SKILL'S
 *     owning org. Persisted shape is `skill.scope` (mirrors the legacy
 *     `(level, scope)` tuple projection used across the catalog).
 *   - For `level: "workspace"`: `organizationId` is unused by the policy
 *     branch (workspace gate checks `actor.organizationId` directly);
 *     pass undefined to make the no-op explicit.
 *   - For `level: "team" | "project" | "personal"`: only `ownerId` matters
 *     for the policy check; `organizationId` is unused — pass undefined.
 *   - For `level: "system"`: only the platform_admin short-circuit
 *     applies; both fields unused.
 *
 * Callers MUST use this helper for any skill access gate to avoid the
 * tautology.
 */
export function buildSkillResourceRef(
  skill: { id: string; level?: string; scope?: string | null },
): SkillResourceRef {
  return {
    resourceType: "skill",
    resourceId: skill.id,
    level: skill.level,
    ownerId: skill.scope ?? undefined,
    // The single non-tautological field: for org-scoped rows the policy
    // compares against the skill's owning org. For every other level the
    // policy branch ignores this field — undefined makes that explicit.
    organizationId: skill.level === "organization" ? (skill.scope ?? undefined) : undefined,
  };
}

/**
 * Single auth-decision chokepoint for non-run resources (skills, registries).
 *
 * Resolves silently on allow, throws AuthzError on deny.
 * - 404 "hidden" when level === "system" and actor is not platform_admin.
 * - 403 "forbidden" for all other denials.
 *
 * IMPORTANT: always load the resource before calling this. Return 404 if
 * the resource is not found regardless of auth (callers must not distinguish
 * "not found" from "denied" via timing).
 */
export function requireResourceAccess(
  actor: ActorContext,
  resource: SkillResourceRef,
  // "read" = resolve / view the resource (the default — including the
  // roleless buildSkillTools model actor reading a workspace-visible chat skill);
  // "manage" =
  // mutate it (skills_installed_upsert). Workspace resources are readable
  // by EVERY workspace user ("Workspace: All" means all users) but only
  // org_admin/org_owner may MANAGE them — the blast-radius guard.
  mode: "read" | "manage" = "read",
): void {
  // platform_admin bypass — mirrors policyAllows shortcircuit
  if (actor.platformRole === "platform_admin") return;

  if (resource.level === "system") {
    throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
  }
  if (resource.level === "organization") {
    if (!resource.organizationId || actor.organizationId !== resource.organizationId) {
      throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
    }
    return;
  }
  if (resource.level === "team" && resource.ownerId) {
    if (actor.teamIds?.includes(resource.ownerId)) return;
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
  }
  if (resource.level === "project" && resource.ownerId) {
    if (actor.projectIds?.includes(resource.ownerId)) return;
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
  }
  if (resource.level === "workspace") {
    // "Workspace: All" = every workspace user.
    // Workspace read requires either an
    // authenticated workspace principal (real userId + orgId — restored
    // via the OBO bridge's transport-stamped actor.orgId in skills
    // handlers' resolveOrgIdFromSession(actor)), OR the internal
    // roleless buildSkillTools model actor reading the chat's OWN system
    // skill (narrowly scoped to that exact skill id + MCP service-account
    // shape). Manage stays admin.
    const hasWorkspacePrincipal =
      Boolean(actor.organizationId) &&
      Boolean(actor.principalId) &&
      actor.principalId !== "system";
    // The chat skill package is split into focused sub-skills
    // (chat-assistant-core plus concern skills). The internal model actor
    // must be able to read any of the chat
    // package's OWN infrastructure prompts (the `@cinatra-ai/chat:chat-`
    // prefix), still narrowly scoped to the exact MCP service-account
    // shape. Manage stays admin.
    const isInternalModelChatSkillRead =
      mode === "read" &&
      actor.principalType === "ServiceAccount" &&
      actor.authSource === "mcp" &&
      actor.principalId === "system" &&
      resource.resourceType === "skill" &&
      typeof resource.resourceId === "string" &&
      resource.resourceId.startsWith("@cinatra-ai/chat:chat-");
    if (mode === "read" && (hasWorkspacePrincipal || isInternalModelChatSkillRead)) return;
    if (mode === "manage") {
      if (actor.orgRole === "org_admin" || actor.orgRole === "org_owner") return;
    }
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
  }
  // Owner short-circuit: personal/agent/third-party/undefined levels fall here.
  if (resource.ownerId && actor.principalId === resource.ownerId) return;
  throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
}

/**
 * Async adapter: resolves teamIds and projectIds from the DB, then delegates
 * to buildActorContextFromPrimitive.
 *
 * PRECONDITION: actor.userId and orgId must both be non-null for DB queries
 * to run. If either is falsy, teamIds/projectIds remain undefined and any
 * team:/project: visibility branch will deny legitimate members.
 * Callers must always resolve orgId from session first.
 *
 * NOTE: readTeamsForUser returns { id, name }[] — we map .id, NOT .teamId.
 */
export async function actorContextFromMcpRequest(
  actor: PrimitiveActorContext,
  orgId?: string | null,
): Promise<ActorContext> {
  let teamIds: string[] | undefined;
  let projectGrants: ProjectGrant[] | undefined;

  if (actor.userId && orgId) {
    const teams = await readTeamsForUser(actor.userId, orgId);
    teamIds = teams.map((t) => t.id);
    // Route through the canonical resolver
    // (owned ∪ accessed, role-by-authority, active-org-anchored). teamRoles
    // is unavailable from public."teamMember" (no role column; verified
    // better-auth-db.ts:93) — missing teamRoles degrades a team-owned
    // implicit grant to {read, team} which is safe (never over-grants) and
    // preserves the binary projectIds back-compat.
    projectGrants = await readProjectGrantsForUser(actor.userId, orgId, {
      teamIds,
    });
  }

  // Populate platformRole from the Better Auth session so admin users are
  // not silently denied on the MCP path. Without this, the kernel's
  // `platform_admin` check inside requireResourceAccess always evaluates
  // false because actor.platformRole was never set.
  // Use the same comma-split pattern as resolveIsPlatformAdminFromSession()
  // in packages/agent-builder/src/mcp/handlers.ts.
  let platformRole: "platform_admin" | "member" | undefined;
  try {
    const session = await getAuthSession();
    if (session) {
      platformRole = isPlatformAdmin(session) ? "platform_admin" : "member";
    }
  } catch {
    // Session lookup failure: leave platformRole undefined.
    // The kernel will still deny system-level resources without admin role.
  }

  // Use the orgRole carried natively on the MCP request context (resolved
  // once at transport context-build time) instead of re-resolving the
  // membership row per gate. ORG-MATCH GUARD (fail closed): the carried role
  // is only meaningful for the transport's own (userId, orgId) identity
  // pair, but this adapter's `orgId` param is sometimes the RESOURCE's org
  // (e.g. template.orgId at handlers.ts agent_template delete) — attaching a
  // role resolved for a different org would mis-scope authority across
  // orgs. Additionally require the store userId to match the envelope's
  // actor.userId so a forwarded envelope for another principal never
  // inherits the transport caller's role. On any mismatch the hint stays
  // undefined and the kernel/gates keep their existing on-demand
  // `resolveOrgRoleForUser` fallback behavior (never widens).
  let orgRole: "org_owner" | "org_admin" | "member" | undefined;
  const requestCtx = mcpRequestContextStorage.getStore();
  if (
    requestCtx?.orgRole &&
    orgId != null &&
    requestCtx.orgId === orgId &&
    actor.userId != null &&
    requestCtx.userId === actor.userId
  ) {
    orgRole = requestCtx.orgRole;
  }

  // Pass projectGrants (canonical axis); projectIds is derived inside
  // buildActorContextFromPrimitive (single derivation).
  return buildActorContextFromPrimitive(actor, orgId, {
    teamIds,
    projectGrants,
    platformRole,
    orgRole,
  });
}

/**
 * Pure helper: maps an AgentAuthPolicyVisibility value to the locked UI-SPEC
 * §C copy strings.
 *
 * Returns null for "owner" and undefined (no element rendered for those).
 */
export function buildScopeReason(
  visibility: AgentAuthPolicyVisibility | undefined,
  context: { orgName?: string; teamName?: string; projectName?: string },
): string | null {
  if (!visibility || visibility === "owner") return null;
  if (visibility.startsWith("team:"))
    return `You can see this because you're a member of ${context.teamName ?? "a team"}.`;
  if (visibility === "org" || visibility.startsWith("org:"))
    return `You can see this because you're a member of ${context.orgName ?? "your organization"}.`;
  if (visibility.startsWith("project:"))
    return `You can see this because you're part of ${context.projectName ?? "a project"}.`;
  if (visibility === "workspace") return "Visible to everyone in the workspace.";
  if (visibility === "admin") return "Visible to platform admins only.";
  return null;
}

// ---------------------------------------------------------------------------
// Run-access enforcer — throws AuthzError on deny
// ---------------------------------------------------------------------------

/**
 * Structural subset of AgentRunRecord needed by enforceRunAccess. Defined here
 * (not imported from store.ts) to avoid the circular import store.ts → auth-policy.ts.
 *
 * `orgId` is populated from `agent_runs.org_id`. The cross-org guard inside
 * `can()` is fully active for run-level reads: when the actor's
 * organizationId (sourced from `session.session.activeOrganizationId` via
 * `ActorRoleHints.actorOrganizationId`) differs from `run.orgId`, the kernel
 * denies unless `actor.platformRole === "platform_admin"`. Combined with
 * the owner short-circuit, the run owner still reaches the policy gate
 * regardless of actor org; non-owners crossing orgs are denied at the kernel.
 *
 * `effectivePolicy` is the resolved AgentAuthPolicy for this run — usually
 * `run.authPolicy ?? template.agentAuthPolicy ?? DEFAULT_AGENT_AUTH_POLICY`.
 * When supplied, `enforceRunAccess` consults the policy fields;
 * when omitted, the policy gate is skipped and only the kernel `can()` call
 * is consulted. List-level probes (`runBy: null, orgId: null`) intentionally
 * do not carry a policy — list-level decisions are made via per-row policy
 * filtering at the list layer.
 */
export type RunForAccessCheck =
  | {
      id: string;
      runBy: string | null;
      orgId?: string | null;
      effectivePolicy?: AgentAuthPolicy | null;
      // Co-owners are populated by PermissionsScreen SSR and any other
      // upstream resolver that builds a RunForAccessCheck. The
      // field is OPTIONAL (undefined treated as []) to keep the existing
      // call-site surface area unchanged; callers that want the co-owner
      // branch to fire must populate it. Used by enforceRunAccess to grant
      // the full COOWNER_OPS set defined at the bottom of this file —
      // currently `list, read, execute, approveHitl, respondToHitl,
      // editOutput, cancel, share`. `run.managePermissions` stays
      // owner+admin only.
      coOwnerUserIds?: string[];
    }
  | null
  | undefined;

/**
 * Resolve the effective AgentAuthPolicy for a run. Single source of truth
 * for the resolution order shared by `readAgentRunById`, the
 * `readAgentRunsByTemplate` post-filter loop, and the PermissionsScreen
 * surfaced source-badge.
 *
 * Order (most-specific wins):
 *   1. run.authPolicy        — per-run override stored in agent_runs.auth_policy
 *   2. template.agentAuthPolicy — template default stored in agent_templates.agent_auth_policy
 *   3. DEFAULT_AGENT_AUTH_POLICY — locked owner-only fallback
 *
 * Three sites independently computed this with
 * `run.authPolicy ?? template.agentAuthPolicy ?? DEFAULT_AGENT_AUTH_POLICY`.
 * A future change to add a fourth tier would require touching all three.
 * Centralized here.
 */
export function resolveEffectivePolicy(
  run: { authPolicy: AgentAuthPolicy | null } | null | undefined,
  template: { agentAuthPolicy: AgentAuthPolicy | null } | null | undefined,
): AgentAuthPolicy {
  return (
    run?.authPolicy ??
    template?.agentAuthPolicy ??
    DEFAULT_AGENT_AUTH_POLICY
  );
}

/**
 * Apply the configured AgentAuthPolicy as a tightening filter on top of the
 * kernel's allow decision. The four policy fields
 * (runListVisibility, runDataVisibility, runExecuteVisibility, allowRunSharing)
 * are stored and surfaced in the UI and consulted here by enforceRunAccess.
 *
 * Mapping operation -> visibility field:
 *   list           -> runListVisibility
 *   read           -> runDataVisibility
 *   execute        -> runExecuteVisibility
 *   approveHitl    -> runExecuteVisibility (HITL approval is an execute-tier op)
 *   respondToHitl  -> runExecuteVisibility (HITL response is an execute-tier op)
 *   editOutput     -> runDataVisibility    (safe default = read tier)
 *
 * Visibility -> who-can-act:
 *   "owner" -> only run owner (already short-circuited above)
 *   "org"   -> any org member (kernel cross-org guard already applied)
 *   "admin" -> only platform_admin (or org_admin where supported)
 *
 * NON-owner callers reach this path only when can() also said allow. The
 * policy tightens — never widens — the kernel's decision: a policy of
 * "admin" demotes an org member from allow to deny; a policy of "org"
 * does not block kernel-allowed admins. The owner grant short-circuits
 * this gate for owners (we never check the policy against the owner).
 *
 * `actor.actorType === "human"` non-owners with platformRole "platform_admin"
 * always satisfy the "admin" visibility tier. This mirrors the authorization
 * kernel's platform_admin-bypasses-org-guard semantics.
 */
export function policyAllows(
  policy: AgentAuthPolicy,
  op: RunAccessOperation,
  actor: ActorContext,
): boolean {
  // platform_admin bypass. The doc comment above promises platform_admin non-owners
  // always satisfy the "admin" visibility tier, and the surrounding
  // admin-override surface (PermissionsScreen canEdit, permissions-actions
  // admin gate) lets admins edit any run's policy. This mirrors the
  // kernel semantic: platform_admin bypasses org-guard and
  // resource-guard alike.
  if (actor.platformRole === "platform_admin") return true;
  let visibility: AgentAuthPolicyVisibility;
  switch (op) {
    case "list":
      visibility = policy.runListVisibility;
      break;
    case "read":
    case "editOutput":
      visibility = policy.runDataVisibility;
      break;
    case "execute":
    case "approveHitl":
    case "respondToHitl":
    case "cancel":
      // cancel is an execute-tier op (mutates run state).
      visibility = policy.runExecuteVisibility;
      break;
    case "share":
      // share is gated by allowRunSharing first; if the policy
      // forbids sharing entirely, deny regardless of visibility tier.
      // Otherwise it surfaces run data to a wider audience and follows
      // runDataVisibility (read-tier).
      if (!policy.allowRunSharing) return false;
      visibility = policy.runDataVisibility;
      break;
    default: {
      // Exhaustive guard. When RunAccessOperation gains a new variant
      // (e.g. "share" for the future allowRunSharing surface), this line
      // fails tsgo and forces an explicit decision
      // about which visibility tier governs the new op. Without the
      // guard, `visibility` would be uninitialized and the post-switch
      // comparisons would throw "Cannot read properties of undefined".
      const _exhaustive: never = op;
      throw new Error(
        `policyAllows: unhandled RunAccessOperation: ${String(_exhaustive)}`,
      );
    }
  }
  // ---------------------------------------------------------------------------
  // Widened visibility branches. Order: workspace bare literal,
  // then team:<id> prefix, then project:<id> prefix. The existing "admin" /
  // "owner" / "org" tail stays unchanged below.
  // ---------------------------------------------------------------------------

  if (visibility === "workspace") {
    // "Workspace: All" means EVERY workspace user can use the resource —
    // not just org_admin/org_owner — matching the UI label
    // "Whole Workspace / All".
    // Safe here because policyAllows() runs AFTER enforceRunAccess() +
    // the kernel can() cross-org guard for non-owners
    // (src/lib/authz/enforce.ts) — an anonymous/missing actor is already
    // rejected upstream and a different-org actor is already blocked by
    // the org guard, so this is "every same-org member of this run's org"
    // for runs. Manage/grant of workspace visibility stays admin-only
    // (canGrantWorkspace +
    // requireResourceAccess mode:"manage").
    return true;
  }
  if (typeof visibility === "string" && visibility.startsWith("org:")) {
    const orgId = visibility.slice("org:".length);
    return Boolean(actor.organizationId === orgId);
  }
  if (typeof visibility === "string" && visibility.startsWith("team:")) {
    const teamId = visibility.slice("team:".length);
    return Boolean(actor.teamIds?.includes(teamId));
  }
  if (typeof visibility === "string" && visibility.startsWith("project:")) {
    const projectId = visibility.slice("project:".length);
    return Boolean(actor.projectIds?.includes(projectId));
  }
  // "admin" tier with non-admin actor: deny (admin bypass already returned
  // above for platform_admin === true).
  if (visibility === "admin") return false;
  // "owner" tier never allows here — owner is short-circuited above the
  // policy gate. Any non-owner reaching this code with visibility="owner"
  // is denied. "org" tier defers to the kernel's already-passed allow
  // decision (which has applied the cross-org guard).
  if (visibility === "owner") return false;
  return true; // "org"
}

/**
 * Enforce run-level access. Resolves silently on allow, throws AuthzError on deny.
 *
 * Status-code policy:
 *   - run is null/undefined           → 404 hidden     ("don't leak existence")
 *   - actor is null/undefined         → 403 forbidden  ("no anonymous run access")
 *   - actor present + can() === false → 403 forbidden  ("decision denial")
 *
 * The 403 vs 404 split here trades information leakage at the list layer
 * (which filters to allowed runs upstream) for the well-behaved "you can't
 * read this specific run" UX (accepted disclosure).
 */
export async function enforceRunAccess(
  run: RunForAccessCheck,
  actor: PrimitiveActorContext | null | undefined,
  op: RunAccessOperation,
  roles?: ActorRoleHints,
): Promise<void> {
  if (!run) {
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Not found.",
    });
  }
  if (!actor) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Run access denied.",
    });
  }

  // Co-owner short-circuit MUST run BEFORE delegating
  // to enforceResourceAccess because runs carry a wider co-owner op set
  // (list / read / execute / approveHitl / respondToHitl / editOutput /
  // cancel / share) than the generic helper's RESOURCE_COOWNER_OPS
  // (read/update/manageMembers only). Keeping it here preserves the
  // run-specific contract.
  // Owner short-circuit. The authorization kernel does not currently
  // grant any role for "actor owns this user-owned resource" (resolveRoles in
  // src/lib/authz/enforce.ts only consults team-owned resources via
  // ownerType==="team", and org roles only fire when actor and resource share
  // an org). Without this short-circuit, every legitimate run owner whose
  // actor came through the MCP bridge would be denied — including for
  // self-owned runs. The default policy is "owner-only" across all
  // ops, so granting the owner here matches both the spec and the user's
  // expectation. NOTE: this is op-agnostic — owners can list/read/execute/
  // approveHitl/respondToHitl/editOutput their own runs. The policy
  // tightening below still tightens visibility above the owner gate (e.g.
  // runDataVisibility="admin" can hide a run from its owner if intentionally
  // configured), so the kernel's allow path is preserved for the non-owner
  // path.
  //
  // Any authenticated actor whose userId matches run.runBy is short-circuited
  // through without calling the kernel. MCP OAuth clients (actorType="model")
  // and A2A agents (actorType="a2a") also carry a userId and store it in
  // run.runBy at creation time, so they must be able to read/resume their own
  // runs — the owner short-circuit is not limited to browser-session humans.
  // The owner short-circuit runs BEFORE the delegated kernel decision AND
  // before policy tightening: owners bypass both `can()` and the
  // AgentAuthPolicy gate (policy tightening only applies to non-owner
  // callers). Functionally identical to the user-owner branch inside
  // enforceResourceAccess; duplicated here so token-scope + policy
  // tightening below are not reached for owners.
  if (
    actor.userId &&
    run.runBy &&
    run.runBy === actor.userId
  ) {
    return;
  }

  // ---------------------------------------------------------------------------
  // Co-owner short-circuit. A row in run_co_owners for this
  // run grants the actor the full COOWNER_OPS set (see the bottom of this
  // file): list, read, execute, approveHitl, respondToHitl, editOutput,
  // cancel, share. `run.managePermissions` stays owner+admin only.
  //
  // The check fires BEFORE the kernel `can()` call because `can()` only
  // grants user-owned resources to the owner (and a co-owner is, by
  // definition, NOT the owner). Without this short-circuit, the co-owner
  // would be denied at the kernel layer for any "owner"-visibility policy.
  // The co-owner branch sits AFTER the owner short-circuit and BEFORE
  // can() / token-scope / policyAllows.
  //
  // The co-owner list is populated upstream. When
  // run.coOwnerUserIds is undefined, the branch is a no-op — callers that
  // want co-owner access enforced must attach the list.
  //
  // OPERATION_PERMISSION mapping recap — co-owners get equal rights to
  // the original owner:
  //   "list"          → run.list                                   → IN
  //   "read"          → run.read                                   → IN
  //   "execute"       → run.resume                                 → IN
  //   "approveHitl"   → run.approveHitl                            → IN
  //   "respondToHitl" → run.respondToHitl                          → IN
  //   "editOutput"    → run.editOutput                             → IN
  //   "cancel"        → run.cancel                                 → IN
  //   "share"         → run.share                                  → IN
  // `run.managePermissions` is the only owner-only op and is NOT in
  // COOWNER_OPS.
  // ---------------------------------------------------------------------------
  // No `actor.actorType === "human"` guard here:
  // A2A callback actors and MCP OAuth clients carry a userId and can be
  // registered as co-owners. Excluding them would cause spurious denials on
  // approveHitl for legitimate A2A co-owners — the co-owner branch matches
  // the owner short-circuit above.
  if (
    actor.userId &&
    run.coOwnerUserIds &&
    run.coOwnerUserIds.length > 0 &&
    run.coOwnerUserIds.includes(actor.userId) &&
    COOWNER_OPS.has(op)
  ) {
    return;
  }

  // Delegate the owner-short-circuit + kernel can()
  // decision to the generic helper. coOwnerUserIds is intentionally
  // cleared on the delegated probe: runs use a wider co-owner op set
  // than the helper's RESOURCE_COOWNER_OPS, so the run-specific branch
  // above is the single source of truth for run co-ownership.
  const permission = OPERATION_PERMISSION[op];
  const probe: ResourceForAccessCheck = {
    resourceType: "run",
    resourceId: run.id,
    organizationId: run.orgId ?? null,
    ownerLevel: "user",
    ownerId: run.runBy ?? "",
    visibility: null,
  };
  try {
    await enforceResourceAccess(probe, actor, permission, roles);
  } catch (err) {
    // Preserve the run-specific deny message contract used by existing
    // tests (handlers-auth-policy + auth-policy-token-scope) while
    // re-using the kernel decision.
    if (err instanceof AuthzError) {
      throw new AuthzError({
        statusCode: err.statusCode,
        reason: err.reason,
        message: err.statusCode === 404 ? "Not found." : "Run access denied.",
      });
    }
    throw err;
  }

  // Build the actor context for the post-delegation token-scope and
  // policy-tightening checks. Both layers operate on the kernel
  // ActorContext shape (tokenScopes + platformRole), which the helper
  // built internally but did not surface.
  const actorContext = buildActorContextFromPrimitive(
    actor,
    run.orgId ?? null,
    roles,
  );

  // Token-scope intersection (additive to the kernel role-grant
  // check above; runs AFTER can() returned allow). If the actor was
  // authenticated via an A2A token with declared scopes, the requested
  // permission MUST be one of those scopes. This is a hard upper bound:
  // even if the actor's role grants the permission, the token does not.
  // A service_account role grants run.read AND
  // agent.execute, but a token whose scope claim is "run.read" only must
  // not be allowed to execute.
  //
  // Skip the check when tokenScopes is undefined — non-A2A actors
  // (HumanUser, InternalWorker, System) carry no token-scope restriction.
  // An empty array (length === 0) is NOT undefined; an empty array means
  // "token issued with no scopes" and denies everything (defensive).
  if (
    actorContext.tokenScopes !== undefined &&
    (actorContext.tokenScopes.length === 0 ||
      !actorContext.tokenScopes.includes(permission))
  ) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Run access denied: token scope insufficient (required ${permission}).`,
    });
  }

  // Tighten the kernel allow decision against the configured
  // AgentAuthPolicy when one is supplied on the run probe. Without this,
  // the four AgentAuthPolicy fields the user configured in the Permissions
  // tab (runListVisibility, runDataVisibility, runExecuteVisibility) had
  // zero effect on access decisions — the UI promised "Anyone in my
  // organization" gating but the back-end was hardcoded to whatever the
  // kernel decided based on role membership.
  if (run.effectivePolicy) {
    if (!policyAllows(run.effectivePolicy, op, actorContext)) {
      throw new AuthzError({
        statusCode: 403,
        reason: "forbidden",
        message: "Run access denied.",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Co-owners have FULL equal rights to the original owner. Adding someone as
// a co-owner is the explicit transfer of equivalent authority.
// ---------------------------------------------------------------------------
const COOWNER_OPS: ReadonlySet<RunAccessOperation> = new Set<RunAccessOperation>([
  "list",
  "read",
  "execute",
  "approveHitl",
  "respondToHitl",
  "editOutput",
  "cancel",
  "share",
]);

// ---------------------------------------------------------------------------
// Full connector use authority.
// ---------------------------------------------------------------------------

/**
 * Delegates connector use checks to the full canonical helper in
 * `@/lib/connector-authority`.
 *
 * This adapter treats the dependency as `required` because legacy call-sites
 * don't carry a requirement field. Newer call-sites should use
 * `requireConnectorAuthority` directly with their per-dep `required|optional`
 * value.
 *
 * Throws an AuthzError-shaped Error on deny.
 */
export async function checkConnectorAccess(
  connectorId: string,
  actor: PrimitiveActorContext,
): Promise<void> {
  const { requireConnectorAuthority } = await import("@/lib/connector-authority");
  const synthActor = {
    principalType: "HumanUser",
    principalId: (actor as { userId?: string }).userId ?? "anonymous",
    authSource: (actor as { source?: string }).source ?? "mcp",
    policyVersion: POLICY_VERSION,
    organizationId: (actor as { orgId?: string }).orgId,
    orgRole: (actor as { orgRole?: string }).orgRole,
    platformRole: (actor as { platformRole?: string }).platformRole,
  } as unknown as Parameters<typeof requireConnectorAuthority>[1];
  const decision = await requireConnectorAuthority(connectorId, synthActor, {
    mode: "use",
    requirement: "required",
  });
  if (!decision.allowed) {
    throw Object.assign(
      new Error(`Connector access denied: ${connectorId} (${decision.reason})`),
      { name: "AuthzError", statusCode: 403, reason: "forbidden" },
    );
  }
}
