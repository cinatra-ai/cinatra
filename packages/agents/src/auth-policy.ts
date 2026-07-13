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

import { can, AuthzError, POLICY_VERSION, logAuditEvent } from "@/lib/authz";
import type { ActorContext, Permission, ResourceRef, AuditEventInput } from "@/lib/authz";
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
import { getAuthSession, isPlatformAdmin, resolveOrgRoleForUser } from "@/lib/auth-session";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
// OBO scope-ceiling helpers (pure zero-dep subpath — never the heavy facade).
//  - `resourceWithinCeiling` + `CeilingResource`: facet form used by the skills
//    gate (`requireResourceAccess`, #1052) AND the agent-template rows
//    (`agent_get` / `agent_list`, #1051).
//  - `oboCeilingContains`: run-chain ⊇ actor-chain containment for
//    `enforceRunAccess` (#1051) — the run's persisted anchor chain must contain
//    every element of the accessing agent's ceiling.
import {
  oboCeilingContains,
  resourceWithinCeiling,
  type CeilingResource,
  type OboCeilingChain,
} from "@cinatra-ai/mcp-server/obo-ceiling";
import { normalizeOwnerLevel } from "@/lib/authz/resource-ref";

// Client-safe types and schema live in auth-policy-types.ts so that client
// components can import them without pulling in this file's server-only guard.
export {
  AgentAuthPolicySchema,
  AgentAuthPolicyVisibilitySchema,
  AgentAuthPolicyVisibilitySelectionSchema,
  DEFAULT_AGENT_AUTH_POLICY,
  normalizeVisibilitySelection,
  isExactlyOwner,
} from "./auth-policy-types";
export type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
  AgentAuthPolicyVisibilitySelection,
  AgentTemplateVisibilityOptions,
} from "./auth-policy-types";
import { AgentAuthPolicySchema, DEFAULT_AGENT_AUTH_POLICY } from "./auth-policy-types";
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
  AgentAuthPolicyVisibilitySelection,
} from "./auth-policy-types";

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
  /**
   * DURABLE owner identity for user-authored (personal/custom) skills
   * (cinatra#1416, AC1). Unlike `ownerId` — which mirrors the MUTABLE
   * `(level, scope)` tuple's scope and is overwritten by the compatibility
   * projection when the skill's access is broadened — this field carries the
   * persisted `ownerUserId` and never changes with the visibility tuple.
   * When set, the owner is admitted for read AND manage BEFORE the policy
   * union runs (broadening a personal skill must never lock its owner out),
   * and `manage` on such a resource is ownership-keyed: scope grants convey
   * read/use only (the AC2/AC5 matrix). Absent for package-shipped skills —
   * every legacy branch is unchanged for those.
   */
  ownerUserId?: string;
  /**
   * CANONICAL enforcement source (multi-scope access W4, #1073). The effective
   * access-policy visibility union for this skill — the skill's own
   * `accessPolicy.runListVisibility` when set, else the parent package's
   * (resolved by the caller). When present and non-empty, `requireResourceAccess`
   * evaluates it ANY-MATCH: an actor matching ANY token is admitted. This is
   * what lets an OR-policy like `[team:t1, project:p2]` admit members of EITHER
   * scope — a projection the single `(level, scope)` tuple cannot represent.
   *
   * When OMITTED the legacy `(level, scope)` branches run instead — the
   * transitional bridge for registry refs and skill rows not yet carrying a
   * canonical policy. `level` is retained for the structural system-hidden gate,
   * the OBO ceiling facet mapping, and the workspace carve-outs (all evaluated
   * around, not replaced by, the policy union) as a label/index hint only —
   * never as the membership decision when `policy` is present.
   */
  policy?: readonly AgentAuthPolicyVisibility[];
  /**
   * AUTHORITATIVE flag: this skill is the `widget-chat.*`-capability skill of
   * an active extension, i.e. the SYSTEM PROMPT served to an UNAUTHENTICATED
   * in-CMS widget chat. Set ONLY by the skills layer from the extension
   * manifest's `cinatra.capabilities` (see `isWidgetChatSkillId`) — NEVER from
   * a slug/id naming convention. When true, the narrow roleless-internal-model
   * read carve-out in `requireResourceAccess` applies (the unauthenticated
   * widget stream has no org/user identity). Defaults to `false` for every
   * other workspace skill, which stays org-gated.
   */
  isWidgetChatSkill?: boolean;
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
  skill: {
    id: string;
    level?: string;
    scope?: string | null;
    /**
     * AUTHORITATIVE widget-chat marker, resolved by the skills layer from the
     * extension manifest (`isWidgetChatSkillId`). Threaded through so the
     * workspace-read carve-out is keyed on the manifest capability contract,
     * never on the skill id's shape. Omitted ⇒ `false`.
     */
    isWidgetChatSkill?: boolean;
    /**
     * EFFECTIVE access policy for this skill — the skill's own `accessPolicy`
     * when set, else the parent package's (the caller resolves the inheritance;
     * see `resolveEffectiveSkillAccessPolicy` in @cinatra-ai/skills). When
     * present its `runListVisibility` union becomes the CANONICAL enforcement
     * source (any-match) and the legacy `(level, scope)` membership branches are
     * bypassed. Omitted / null ⇒ the transitional `(level, scope)` fallback.
     */
    accessPolicy?: AgentAuthPolicy | null;
    /**
     * DURABLE owner user id for user-authored (personal/custom) skills
     * (cinatra#1416, AC1) — the persisted `ownerUserId` catalog field, NOT the
     * tuple's `scope`. Thread it for every catalog-row-backed ref so the owner
     * keeps read+manage after the skill's access is broadened (the projection
     * rewrites `scope` to the granted locus). Omit/null for package skills.
     */
    ownerUserId?: string | null;
  },
): SkillResourceRef {
  return {
    resourceType: "skill",
    resourceId: skill.id,
    level: skill.level,
    ownerId: skill.scope ?? undefined,
    ownerUserId: skill.ownerUserId ?? undefined,
    // The single non-tautological field: for org-scoped rows the policy
    // compares against the skill's owning org. For every other level the
    // policy branch ignores this field — undefined makes that explicit.
    organizationId: skill.level === "organization" ? (skill.scope ?? undefined) : undefined,
    isWidgetChatSkill: skill.isWidgetChatSkill ?? false,
    // Canonical multi-scope union (W4). `runListVisibility` is the field the
    // catalog projects to `(level, scope)` (see writeSkillAccessPolicy), so it
    // is the authoritative "who may see/use this skill" dimension. Undefined
    // when the skill carries no effective policy → the tuple fallback runs.
    policy: skill.accessPolicy?.runListVisibility,
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
  // OBO scope-ceiling containment — evaluated BEFORE the platform_admin bypass
  // (and before every owner/level short-circuit below), so a delegated agent run
  // stays confined to the agent's anchored scope even when the invoking user is a
  // platform admin OR the resource's own owner. `actor.oboCeiling` is set ONLY for
  // agent-run OBO delegated actors (threaded from the signed token onto the kernel
  // actor in actorContextFromMcpRequest); undefined ⇒ no-op for every human /
  // session / machine caller. Load-bearing ordering, mirrors the #1051 kernel
  // surfaces and the workflows/dashboards resolvers in this wave.
  if (
    actor.oboCeiling &&
    !resourceWithinCeiling(skillResourceToCeilingFacets(resource, actor), actor.oboCeiling)
  ) {
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
  }
  // platform_admin bypass — mirrors policyAllows shortcircuit
  if (actor.platformRole === "platform_admin") return;

  if (resource.level === "system") {
    throw new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." });
  }
  // DURABLE-owner short-circuit for user-authored skills (cinatra#1416, AC1).
  // Ownership is a persisted attribute (`ownerUserId`), independent of the
  // mutable `(level, scope)` tuple AND of the policy union below: broadening a
  // personal skill to `[team:t1]` strips the redundant `owner` token
  // (normalizeVisibilitySelection) and rewrites the tuple's scope to the
  // granted locus, so without this check the owner would be locked out of
  // their own skill. The owner is admitted for read AND manage. Runs AFTER the
  // OBO ceiling containment (a delegated actor stays confined even when the
  // invoking user owns the resource) — mirroring the platform_admin ordering.
  if (resource.ownerUserId && actor.principalId === resource.ownerUserId) return;
  // Ownership-keyed MANAGE for user-authored skills (cinatra#1416, AC2/AC5).
  // On a durable-owner skill, only the owner (returned just above) and
  // platform_admin (returned earlier) may MANAGE; every other principal —
  // members of granted scopes included — gets read/use ONLY. This runs BEFORE
  // both the canonical-policy union AND the (level, scope) tuple fallback
  // below, so a broadened personal skill that projected to level="team"/
  // "project" (and thus has no canonical `policy` on the ref) can never leak
  // `manage` to a tuple-matching scope member. Package-shipped skills (no
  // ownerUserId) keep the legacy union/tuple manage semantics untouched.
  if (mode === "manage" && resource.ownerUserId) {
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
  }
  // Canonical multi-scope enforcement (W4, #1073). When the ref carries an
  // effective access policy, the visibility union is the SOLE membership
  // decision: admit on ANY matching token (OR-visibility), else deny. This
  // supersedes the `(level, scope)` branches below, which the tuple can no
  // longer faithfully represent for an OR-policy like `[team:t1, project:p2]`.
  // A single-token policy reproduces the exact pre-array decision, so migrated
  // callers are behaviour-preserving. `level`/`ownerId`/`organizationId` remain
  // available above (system-hidden, OBO facets) and inside the workspace/owner
  // token predicates as structural hints — never as the union decision here.
  if (resource.policy && resource.policy.length > 0) {
    // (The owned-skill `manage` denial is hoisted above the policy branch so
    // it also covers the tuple-fallback path — cinatra#1416, AC2/AC5.)
    for (const token of resource.policy) {
      if (matchSkillAccessToken(token, actor, resource, mode)) return;
    }
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
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
    if (decideWorkspaceAccess(actor, resource, mode)) return;
    throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
  }
  // Owner short-circuit: personal/agent/third-party/undefined levels fall here.
  if (resource.ownerId && actor.principalId === resource.ownerId) return;
  throw new AuthzError({ statusCode: 403, reason: "forbidden", message: "Access denied." });
}

/**
 * Workspace-tier read/manage decision — the SINGLE source of truth for
 * "Workspace: All" access, shared by the legacy `level === "workspace"` branch
 * and the canonical policy branch's `workspace` token predicate so the two can
 * never drift.
 *
 * Read is granted to either an authenticated workspace principal (real userId +
 * orgId — restored via the OBO bridge's transport-stamped actor.orgId in skills
 * handlers' resolveOrgIdFromSession(actor)), OR the internal roleless
 * buildSkillTools model actor reading the chat package's OWN infrastructure
 * prompts (`@cinatra-ai/chat:chat-` prefix, narrowly scoped to the MCP
 * service-account shape), OR that same roleless actor reading an
 * AUTHORITATIVELY-flagged widget-chat skill (`isWidgetChatSkill`, stamped by the
 * skills layer from the extension manifest's `widget-chat.*` capability — never
 * the id's shape, so an arbitrary look-alike skill is not exposed and the
 * cross-org workspace-read enumeration guard holds). Manage stays admin.
 */
function decideWorkspaceAccess(
  actor: ActorContext,
  resource: SkillResourceRef,
  mode: "read" | "manage",
): boolean {
  const hasWorkspacePrincipal =
    Boolean(actor.organizationId) &&
    Boolean(actor.principalId) &&
    actor.principalId !== "system";
  const isInternalModelChatSkillRead =
    mode === "read" &&
    actor.principalType === "ServiceAccount" &&
    actor.authSource === "mcp" &&
    actor.principalId === "system" &&
    resource.resourceType === "skill" &&
    typeof resource.resourceId === "string" &&
    resource.resourceId.startsWith("@cinatra-ai/chat:chat-");
  const isInternalModelWidgetChatSkillRead =
    mode === "read" &&
    actor.principalType === "ServiceAccount" &&
    actor.authSource === "mcp" &&
    actor.principalId === "system" &&
    resource.resourceType === "skill" &&
    resource.isWidgetChatSkill === true;
  if (
    mode === "read" &&
    (hasWorkspacePrincipal ||
      isInternalModelChatSkillRead ||
      isInternalModelWidgetChatSkillRead)
  )
    return true;
  if (mode === "manage") {
    return actor.orgRole === "org_admin" || actor.orgRole === "org_owner";
  }
  return false;
}

/**
 * Per-token decision for the canonical skill access-policy union (W4, #1073).
 * Folded any-match by `requireResourceAccess`: the actor is admitted iff ANY
 * token in the effective `runListVisibility` union admits them. Each token
 * reproduces the EXACT membership semantics of the legacy `(level, scope)`
 * branch it replaces, so a single-token policy is behaviour-identical to the
 * pre-array gate and a multi-token policy is their union (OR-visibility).
 *
 * Runs AFTER the platform_admin bypass, the system-hidden gate, and the OBO
 * ceiling containment check in `requireResourceAccess` — none of which this
 * predicate re-evaluates.
 *
 *   workspace    → shared decideWorkspaceAccess (principal / internal-model
 *                  carve-outs for read; org_admin/org_owner for manage)
 *   org:<id>     → actor's active org equals <id>
 *   org (legacy) → actor's active org equals the ref's owning org (fail closed
 *                  when the owning org is unknown — a bare `org` token carries
 *                  no id of its own)
 *   team:<id>    → actor is a member of team <id>
 *   project:<id> → actor holds a grant on project <id>
 *   owner        → actor is the resource owner (mirrors the owner short-circuit)
 *   admin        → deny. For SKILLS `admin` means "platform admins only" (the
 *                  picker's "Workspace: Admins only"; legacy projection was
 *                  `level:"system"`, hidden from non-platform admins). The
 *                  platform_admin bypass already returned upstream, so any
 *                  non-platform actor reaching this token is denied in BOTH
 *                  read and manage — matching the legacy system-hidden gate and
 *                  the run matcher. (NOT org_admin: that would OVER-GRANT manage
 *                  vs the tuple — a distinct token from `workspace`, whose
 *                  manage IS org_admin via decideWorkspaceAccess.)
 */
function matchSkillAccessToken(
  token: AgentAuthPolicyVisibility,
  actor: ActorContext,
  resource: SkillResourceRef,
  mode: "read" | "manage",
): boolean {
  if (token === "workspace") return decideWorkspaceAccess(actor, resource, mode);
  if (token.startsWith("org:")) {
    return actor.organizationId === token.slice("org:".length);
  }
  if (token === "org") {
    // Bare legacy `org` carries no id — bind to the ref's owning org and fail
    // closed when unknown, so it never widens to "any org member".
    return Boolean(resource.organizationId) && actor.organizationId === resource.organizationId;
  }
  if (token.startsWith("team:")) {
    return Boolean(actor.teamIds?.includes(token.slice("team:".length)));
  }
  if (token.startsWith("project:")) {
    return Boolean(actor.projectIds?.includes(token.slice("project:".length)));
  }
  if (token === "owner") {
    // Durable owner identity first (user-authored skills, cinatra#1416): the
    // tuple's `ownerId`/scope is a projection that stops naming the owner once
    // access is broadened. Fall back to the tuple for package-era refs.
    if (resource.ownerUserId) return actor.principalId === resource.ownerUserId;
    return Boolean(resource.ownerId) && actor.principalId === resource.ownerId;
  }
  // `admin` = platform-admin-only for skills (legacy `level:"system"` gate).
  // platform_admin already returned upstream, so deny here in read AND manage —
  // granting org_admin would OVER-GRANT manage vs the tuple (`workspace` is the
  // distinct token whose manage IS org_admin, via decideWorkspaceAccess above).
  // `admin` and any unrecognized token: deny.
  return false;
}

/**
 * Map a `SkillResourceRef` onto the shared `CeilingResource` facets consumed by
 * `resourceWithinCeiling`. The skill catalog's `level`
 * (system/team/organization/workspace/project/personal/agent) collapses onto the
 * ceiling's owner axis (user/team/organization/workspace) + project refinement:
 *
 *   - system                 → no tenant/owner/project ⇒ outside EVERY org-floored
 *                              ceiling (a platform-global skill is never within an
 *                              agent's org/user/team/project anchor → denied).
 *   - organization           → owner {organization, org}, orgId = the skill's REAL
 *                              owning org (`resource.organizationId`), so a
 *                              cross-org org-skill fails the ceiling's org floor.
 *   - team | workspace       → owner {tier, ownerId}.
 *   - project                → projectId = ownerId (the project id); no owner element.
 *   - personal | agent | ⊥   → owner {user, ownerId} (personal clamps to user tier).
 *
 * For the grant-scoped levels whose ref does not carry an explicit org
 * (team/workspace/project/personal), orgId falls back to the invoker's active org.
 * That is sound: these are org-scoped grants and an agent-run OBO actor shares the
 * run org that produced the chain's org floor, so the OWNER / PROJECT element does
 * the real narrowing while the org floor stays satisfied for in-org resources
 * (genuine cross-org skills are never resolved into the ref on the in-org OBO path).
 */
function skillResourceToCeilingFacets(
  resource: SkillResourceRef,
  actor: ActorContext,
): CeilingResource {
  const level = resource.level;
  if (level === "system") {
    return { orgId: null, owner: null, projectId: null };
  }
  const orgId = resource.organizationId ?? actor.organizationId ?? null;
  if (level === "project") {
    return { orgId, owner: null, projectId: resource.ownerId ?? null };
  }
  if (level === "team" || level === "workspace") {
    return resource.ownerId
      ? { orgId, owner: { tier: level, id: resource.ownerId }, projectId: null }
      : { orgId, owner: null, projectId: null };
  }
  if (level === "organization") {
    return {
      orgId,
      owner: orgId ? { tier: "organization", id: orgId } : null,
      projectId: null,
    };
  }
  // personal | agent | undefined ⇒ user-tier owner (personal-skill tools clamp to
  // the invoking user's tier).
  return resource.ownerId
    ? { orgId, owner: { tier: "user", id: resource.ownerId }, projectId: null }
    : { orgId, owner: null, projectId: null };
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
  const built = buildActorContextFromPrimitive(actor, orgId, {
    teamIds,
    projectGrants,
    platformRole,
    orgRole,
  });

  // Thread the agent-run OBO scope-ceiling from the transport request frame onto
  // the kernel actor so `requireResourceAccess` can confine delegated skill reads
  // to the agent's anchored scope. Present ONLY for agent-run OBO delegations
  // (stamped on the frame by the MCP boundary from the signed token); undefined
  // for chat / session / machine callers, leaving their behavior unchanged.
  if (requestCtx?.oboCeiling) {
    (built as ActorContext).oboCeiling = requestCtx.oboCeiling;
  }
  return built;
}

/**
 * Resolve the admin-standing inputs the non-published agent_template visibility
 * gate (`applyAgentTemplateVisibility` in ./store, admin-parity P4 cinatra#1129)
 * needs from a Better Auth session: the acting user id, their platform role,
 * their ACTIVE-org role, and active org id. A `platform_admin` sees every
 * non-published template; an org admin/owner of a template's OWNING org sees
 * that org's non-published templates (the store gate compares this active org id
 * to the template's `orgId`, so an admin of a DIFFERENT org never gains
 * visibility). Returns `includeNonPublished: true` so callers can spread the
 * whole bag straight into `readAgentTemplateBySlug`. An anonymous session yields
 * the legacy behaviour (no admin standing, no user id).
 *
 * Lives here (not a standalone module) so it reuses this file's existing
 * `@/lib/auth-session` edge and adds no new node to the route module graph.
 * The return shape is structurally the store's `AgentTemplateVisibilityOptions`.
 */
export async function resolveTemplateVisibilityActor(
  session:
    | {
        user?: { id?: string | null; role?: string | null } | null;
        session?: { activeOrganizationId?: string | null } | null;
      }
    | null
    | undefined,
): Promise<{
  actorUserId: string | null;
  includeNonPublished: boolean;
  actorPlatformRole: "platform_admin" | "member";
  actorOrgRole: "org_owner" | "org_admin" | "member" | undefined;
  actorOrganizationId: string | null;
}> {
  const actorUserId = session?.user?.id ?? null;
  if (!actorUserId) {
    return {
      actorUserId: null,
      includeNonPublished: true,
      actorPlatformRole: "member",
      actorOrgRole: undefined,
      actorOrganizationId: null,
    };
  }
  const actorOrganizationId = session?.session?.activeOrganizationId ?? null;
  const actorPlatformRole = isPlatformAdmin(session) ? "platform_admin" : "member";
  // platform_admin bypasses the org-anchored branch; only query the membership
  // row for a non-platform-admin with an active org.
  const actorOrgRole =
    actorPlatformRole === "platform_admin" || !actorOrganizationId
      ? undefined
      : await resolveOrgRoleForUser(actorOrganizationId, actorUserId);
  return {
    actorUserId,
    includeNonPublished: true,
    actorPlatformRole,
    actorOrgRole,
    actorOrganizationId,
  };
}

/** Per-token scope-reason copy (UI-SPEC §C). Returns null for "owner" (owner
 * access is implicit) and any unrecognized token. */
function scopeReasonForToken(
  visibility: AgentAuthPolicyVisibility,
  context: { orgName?: string; teamName?: string; projectName?: string },
): string | null {
  if (visibility === "owner") return null;
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

/**
 * Pure helper: maps an AgentAuthPolicyVisibility value — a single token OR a
 * NON-EMPTY selection array (multi-scope W2) — to the locked UI-SPEC §C copy.
 *
 * A selection joins its DISTINCT per-token reasons (a union of grants). A
 * scalar (or single-token array) reduces to the exact pre-array single reason,
 * so existing single-token callers are unchanged. `owner` tokens contribute no
 * reason; an all-`owner`, empty, or undefined input returns null. `context`
 * carries one org/team/project name set — a multi-token selection spanning
 * several concrete loci reuses those names (richer per-token naming is the W3
 * picker's wiring).
 */
export function buildScopeReason(
  visibility:
    | AgentAuthPolicyVisibility
    | readonly AgentAuthPolicyVisibility[]
    | undefined,
  context: { orgName?: string; teamName?: string; projectName?: string },
): string | null {
  if (!visibility) return null;
  const tokens: readonly AgentAuthPolicyVisibility[] = Array.isArray(visibility)
    ? visibility
    : [visibility];
  const reasons: string[] = [];
  for (const t of tokens) {
    const r = scopeReasonForToken(t, context);
    if (r && !reasons.includes(r)) reasons.push(r);
  }
  return reasons.length > 0 ? reasons.join(" ") : null;
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
      /**
       * The run's PERSISTED OBO scope-ceiling chain (`agent_runs.obo_ceiling`,
       * derived at dispatch from the run's LOCKED template anchor + org +
       * project — W1/#1050). Surfaced onto `AgentRunRecord` by `deserializeRun`,
       * so every full-row caller (`readAgentRunById`, the run mutation handlers,
       * the per-row list filters) carries it via `{ ...run }`. The run ceiling
       * gate (`enforceRunAccess`) treats:
       *   - `undefined` (a synthetic probe that is NOT a real persisted run:
       *     the template-execute probe, the connector probe) → SKIP; those gate
       *     a capability, not access to an existing run row;
       *   - `null` (a real run whose stored chain is malformed/corrupt) → DENY
       *     (fail closed);
       *   - a chain → containment check against the accessing agent's ceiling.
       */
      oboCeiling?: OboCeilingChain | null;
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
  // Multi-scope W2: each visibility field is a NON-EMPTY array (a union of
  // grants). The matcher is ANY-MATCH — the actor is admitted iff SOME token in
  // the selected field admits them (`matchRunVisibilityToken` is the per-token
  // decision). A single-token field (every writer until the W3 multi-select
  // picker) reduces to the exact pre-array scalar decision, so this can neither
  // over- nor under-grant an existing policy.
  let tokens: AgentAuthPolicyVisibilitySelection;
  switch (op) {
    case "list":
      tokens = policy.runListVisibility;
      break;
    case "read":
    case "editOutput":
      tokens = policy.runDataVisibility;
      break;
    case "execute":
    case "approveHitl":
    case "respondToHitl":
    case "cancel":
      // cancel is an execute-tier op (mutates run state).
      tokens = policy.runExecuteVisibility;
      break;
    case "share":
      // share is gated by allowRunSharing first; if the policy
      // forbids sharing entirely, deny regardless of visibility tier.
      // Otherwise it surfaces run data to a wider audience and follows
      // runDataVisibility (read-tier).
      if (!policy.allowRunSharing) return false;
      tokens = policy.runDataVisibility;
      break;
    default: {
      // Exhaustive guard. When RunAccessOperation gains a new variant this
      // line fails tsgo and forces an explicit decision about which visibility
      // tier governs the new op.
      const _exhaustive: never = op;
      throw new Error(
        `policyAllows: unhandled RunAccessOperation: ${String(_exhaustive)}`,
      );
    }
  }
  // Any-match: admit if ANY token in the field admits the actor. `op` is
  // forwarded so the owner-aware "admin" tier can hold the H4 doctrine — it
  // widens NON-execute ops to org admins but never an execute-tier op (see
  // matchRunVisibilityToken).
  return tokens.some((visibility) => matchRunVisibilityToken(visibility, actor, op));
}

// Execute-tier run ops (mutate run state). These map to runExecuteVisibility in
// policyAllows. The owner-aware "admin" visibility tier must NOT widen these to
// org admins: admin EXECUTE-widening, if ever wanted, belongs in the kernel's
// platform_admin DIRECT_GRANTS (H4 doctrine), never in policyAllows.
const RUN_EXECUTE_TIER_OPS: ReadonlySet<RunAccessOperation> = new Set([
  "execute",
  "approveHitl",
  "respondToHitl",
  "cancel",
]);

/**
 * Per-token run-visibility decision — the single-token predicate the any-match
 * matcher in {@link policyAllows} folds over each field's token array. Runs
 * ONLY for non-platform-admin actors (platform_admin is short-circuited in
 * policyAllows before any token is consulted) and AFTER the kernel `can()`
 * cross-org guard.
 *
 * Tiers (run path). NOTE: `"admin"` here is OWNER-AWARE (admin-parity P4,
 * cinatra#1129) — it now CONVERGES with the owner-aware `"admin"` in the
 * extension matcher (`packages/extensions/src/enforce-extension-access.ts`
 * `hasAdminStandingOverExtension`): platform_admin OR an org admin/owner of the
 * run's org. platform_admin is short-circuited in policyAllows; an
 * org_admin/org_owner is admitted here.
 *   workspace    → every same-org member (guard already passed) → allow
 *   org:<id>     → actor's active org equals <id>
 *   team:<id>    → actor is a member of <id>
 *   project:<id> → actor holds a grant on <id>
 *   admin        → org_admin/org_owner of the run's org for a NON-execute op;
 *                  execute-tier ops keep the platform-admin-only semantics
 *                  (H4 doctrine — see below). platform_admin already returned
 *                  true upstream.
 *   owner        → deny (owner is short-circuited above the policy gate)
 *   org (legacy) → allow (kernel cross-org guard already applied)
 */
function matchRunVisibilityToken(
  visibility: AgentAuthPolicyVisibility,
  actor: ActorContext,
  op: RunAccessOperation,
): boolean {
  if (visibility === "workspace") {
    // "Workspace: All" means EVERY workspace user can use the resource — not
    // just org_admin/org_owner — matching the UI label "Whole Workspace / All".
    // Safe here because policyAllows() runs AFTER enforceRunAccess() + the
    // kernel can() cross-org guard for non-owners (src/lib/authz/enforce.ts):
    // an anonymous/missing actor is already rejected upstream and a
    // different-org actor is already blocked by the org guard. Manage/grant of
    // workspace visibility stays admin-only (canGrantWorkspace +
    // requireResourceAccess mode:"manage").
    return true;
  }
  if (typeof visibility === "string" && visibility.startsWith("org:")) {
    return actor.organizationId === visibility.slice("org:".length);
  }
  if (typeof visibility === "string" && visibility.startsWith("team:")) {
    return Boolean(actor.teamIds?.includes(visibility.slice("team:".length)));
  }
  if (typeof visibility === "string" && visibility.startsWith("project:")) {
    return Boolean(
      actor.projectIds?.includes(visibility.slice("project:".length)),
    );
  }
  // "admin" tier — owner-aware (admin-parity P4, cinatra#1129). platform_admin
  // already returned true in policyAllows above; an org admin/owner of the
  // run's org is admitted here for LIST / READ / editOutput / share.
  // matchRunVisibilityToken runs ONLY after enforceRunAccess + the kernel can()
  // cross-org guard, so a non-owner actor reaching this token is same-org as the
  // run — an org_admin/org_owner here IS an admin of the run's org (mirrors
  // hasAdminStandingOverExtension). A plain member is still denied.
  //
  // H4 DOCTRINE (execute stays out of policyAllows): the "member" role already
  // carries run.resume and org_admin inherits member, so a same-org org admin
  // PASSES the kernel can() gate for execute-tier ops and would reach this
  // token. We must therefore explicitly refuse to widen an execute-tier op's
  // "admin" policy to org admins here — otherwise an admin-tier
  // runExecuteVisibility would silently grant org admins execute. Admin
  // execute-widening, if ever wanted, belongs in the kernel's platform_admin
  // DIRECT_GRANTS, never in this matcher.
  if (visibility === "admin") {
    if (RUN_EXECUTE_TIER_OPS.has(op)) return false;
    return actor.orgRole === "org_admin" || actor.orgRole === "org_owner";
  }
  // "owner" tier never allows here — owner is short-circuited above the policy
  // gate. Any non-owner reaching this code with visibility="owner" is denied.
  if (visibility === "owner") return false;
  // "org" (legacy bare token) defers to the kernel's already-passed allow
  // decision (which has applied the cross-org guard).
  return true;
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

  const permission = OPERATION_PERMISSION[op];

  // ---------------------------------------------------------------------------
  // Token-scope ceiling — enforced FIRST, BEFORE the owner / co-owner
  // short-circuits (codex Q1 "two invariants").
  //
  // A token's scope claim is a HARD upper bound that no role grant — not even
  // run ownership or co-ownership — can exceed. Previously this check ran only
  // AFTER the owner / co-owner short-circuits returned, so a token-bearing
  // owner or co-owner could perform an op its token did not grant (e.g. a
  // read-scoped A2A token resuming its own run). Moving it ahead of the
  // short-circuits closes that gap while preserving the original semantics for
  // non-token actors:
  //   - tokenScopes === undefined  -> non-token actor (HumanUser via UI,
  //     InternalWorker via BullMQ, internal model/agent): NO ceiling, skip.
  //   - tokenScopes === []         -> token issued with no / no-intersecting
  //     scopes: DENY ALL (fail-closed behavior; the
  //     producer must emit [] not undefined for A2A — see a2a-auth.ts).
  //   - tokenScopes missing `permission` -> DENY this op.
  // The post-delegation block below is now redundant for the ceiling but is
  // kept as defense-in-depth (it re-derives the same actorContext).
  const ceilingScopes = buildActorContextFromPrimitive(
    actor,
    run.orgId ?? null,
    roles,
  ).tokenScopes;
  if (
    ceilingScopes !== undefined &&
    (ceilingScopes.length === 0 || !ceilingScopes.includes(permission))
  ) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: `Run access denied: token scope insufficient (required ${permission}).`,
    });
  }

  // ---------------------------------------------------------------------------
  // Agent-run OBO scope-ceiling — a SECOND hard upper bound, enforced HERE
  // (alongside the token-scope ceiling above) BEFORE the runBy owner / co-owner
  // short-circuits AND before the delegated kernel `can()` / platform-admin
  // path (W2/#1051). Otherwise a run-owner or platform-admin invoker would
  // nullify the ceiling for every delegated run, letting a narrowly-anchored
  // agent reach a run outside its scope.
  //
  // Fires ONLY for agent-run-OBO delegated actors (`actor.oboCeiling` present;
  // undefined for every human / session / A2A / machine caller → skip). The
  // run is bounded by its OWN persisted chain (`run.oboCeiling`), which was
  // derived at dispatch from the run's LOCKED template anchor + org + project —
  // NOT from `runBy`, so an agent always reads its own run (its run's anchor ==
  // the agent's anchor) while a team-anchored agent stays confined to
  // team-anchored runs. `oboCeilingContains(run.oboCeiling, actor.oboCeiling)`
  // holds iff every element of the agent's ceiling is contained in the run's
  // chain (agent ⊆ run) — the containment form of "the run is within the
  // agent's ceiling".
  //
  //   - run.oboCeiling === undefined → a synthetic probe (template-execute /
  //     connector), NOT a real persisted run — SKIP (the probe gates a
  //     capability, not access to a run row);
  //   - run.oboCeiling === null      → a real run with a corrupt stored chain
  //     — DENY (fail closed);
  //   - a chain that does not contain the agent's chain → DENY.
  if (
    actor.oboCeiling &&
    run.oboCeiling !== undefined &&
    !oboCeilingContains(run.oboCeiling, actor.oboCeiling)
  ) {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Run access denied: outside agent scope ceiling.",
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

  // admin-parity P4 (cinatra#1129): resolve the actor's role in the RUN's org so
  // the owner-aware run "admin" visibility tier — and the kernel's org grant —
  // recognize an org admin/owner of the run's org on surfaces that do NOT
  // pre-resolve it (the MCP role hints). This is the run access layer deriving
  // orgRole "from userId + the run's organizationId" per the #1129 plan, so
  // those callers need not thread orgRole.
  //
  // SAFETY GUARD — the derivation fires ONLY when the caller declared the
  // actor's active org (`roles.actorOrganizationId`) AND it equals the run's
  // org. This binds the derived authority to the org the actor is ALREADY
  // acting in: it can never grant a multi-org user cross-active-org access, and
  // a session-backed caller that forgets `actorOrganizationId` degrades to the
  // pre-P4 deny (never a widening) rather than defaulting the org to run.orgId.
  // Also excludes owner/co-owner (already returned above) and platform_admin
  // (bypasses every gate). MUST run BEFORE the kernel probe so an org admin
  // actually passes `can()` for run.read/list. resolveOrgRoleForUser is
  // per-request cached, so the list path's per-row calls collapse to one query.
  let effectiveRoles = roles;
  if (
    roles?.orgRole === undefined &&
    roles?.platformRole !== "platform_admin" &&
    actor.userId &&
    run.orgId &&
    roles?.actorOrganizationId === run.orgId
  ) {
    const derivedOrgRole = await resolveOrgRoleForUser(run.orgId, actor.userId);
    if (derivedOrgRole) effectiveRoles = { ...roles, orgRole: derivedOrgRole };
  }

  // Delegate the owner-short-circuit + kernel can()
  // decision to the generic helper. coOwnerUserIds is intentionally
  // cleared on the delegated probe: runs use a wider co-owner op set
  // than the helper's RESOURCE_COOWNER_OPS, so the run-specific branch
  // above is the single source of truth for run co-ownership.
  // `permission` was resolved at the top for the token-scope ceiling.
  const probe: ResourceForAccessCheck = {
    resourceType: "run",
    resourceId: run.id,
    organizationId: run.orgId ?? null,
    ownerLevel: "user",
    ownerId: run.runBy ?? "",
    visibility: null,
  };
  try {
    await enforceResourceAccess(probe, actor, permission, effectiveRoles);
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
    effectiveRoles,
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

// ---------------------------------------------------------------------------
// agent_get read authorization
// ---------------------------------------------------------------------------
/**
 * Cross-org read gate for the `agent_get` MCP handler. `agent_get` returns a
 * FULL agent template (including its agentAuthPolicy + input schemas); without
 * this gate any authenticated MCP caller who knows (or guesses) a template id
 * could read any template across orgs. Mirrors the org-scoped sibling read
 * paths (agent_list / agent_run_get):
 *   - a non-admin with no active org is denied BEFORE any store read;
 *   - a non-admin may only read a template in their active org — a cross-org row
 *     is 404-hidden (returns the same "Template not found" as a genuine miss, so
 *     a cross-org template's existence is not disclosed) and the denied read is
 *     audited;
 *   - a platform admin may read across orgs (consistent with agent_list's admin
 *     path); a legacy null-org template is denied to non-admins (fail-closed).
 *
 * `organizationId` / `isAdmin` are resolved by the caller from the server-only,
 * unforgeable actor envelope (falling back to the Better Auth session) — never
 * caller-supplied tool input. Returns the template on success, or an `{ error }`
 * envelope on denial/miss (the handler forwards either verbatim).
 */
/**
 * Facet-based agent-run OBO scope-ceiling test for an agent-template row
 * (W2/#1051) — shared by `agent_get` (authorizeAgentTemplateRead) and the
 * `agent_list` per-row filter. Returns `true` when no ceiling applies (a
 * non-OBO caller: `oboCeiling` undefined). Agent templates carry no project
 * refinement, so a project-anchored ceiling (a `{project,P}` element under
 * satisfy-all) always denies — the correct fail-closed confinement. A null
 * owner anchor normalizes to the organization tier (deny narrower agents).
 */
export function agentTemplateWithinOboCeiling(
  oboCeiling: OboCeilingChain | undefined,
  template: {
    orgId?: string | null;
    ownerLevel?: string | null;
    ownerId?: string | null;
  },
): boolean {
  if (!oboCeiling) return true;
  return resourceWithinCeiling(
    {
      orgId: template.orgId ?? null,
      owner: {
        tier: normalizeOwnerLevel(template.ownerLevel ?? "organization"),
        id: template.ownerId ?? "",
      },
      projectId: null,
    },
    oboCeiling,
  );
}

export async function authorizeAgentTemplateRead(
  actor:
    | { userId?: string; actorType?: string; source?: string; oboCeiling?: OboCeilingChain }
    | undefined,
  templateId: string,
  organizationId: string | undefined,
  isAdmin: boolean,
): Promise<unknown> {
  if (!organizationId && !isAdmin) {
    return { error: "Active organization required." };
  }
  // Dynamic import avoids a static cycle with ../store (which type-imports this
  // module); ../store is already reachable via the handlers hub, so gating here
  // adds no new module to any route's reachable first-party graph.
  const { readAgentTemplateById } = await import("./store");
  const template = await readAgentTemplateById(templateId);
  if (!template) return { error: `Template not found: ${templateId}` };
  if (!isAdmin && (template as { orgId?: string | null }).orgId !== organizationId) {
    void logAuditEvent({
      actorPrincipalId: actor?.userId,
      actorPrincipalType: (actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
      authSource: (actor?.source as AuditEventInput["authSource"]) ?? "mcp",
      resourceType: "agent_template",
      resourceId: templateId,
      operation: "read",
      decision: "denied",
      policyVersion: POLICY_VERSION,
    });
    return { error: `Template not found: ${templateId}` };
  }
  // Agent-run OBO scope-ceiling (W2/#1051): confine a delegated agent to
  // agent-template rows within its anchored scope, checked before the row is
  // returned (and after the org-tenant guard above). Fires only for
  // agent-run-OBO actors (`actor.oboCeiling` present); a null anchor normalizes
  // to the organization tier (deny narrower agents, per the derive convention).
  // Denials are surfaced as the same 404-equivalent "not found" as the
  // cross-org guard so a confined agent cannot enumerate template ids.
  if (
    actor?.oboCeiling &&
    !agentTemplateWithinOboCeiling(
      actor.oboCeiling,
      template as { orgId?: string | null; ownerLevel?: string | null; ownerId?: string | null },
    )
  ) {
    void logAuditEvent({
      actorPrincipalId: actor?.userId,
      actorPrincipalType: (actor?.actorType as AuditEventInput["actorPrincipalType"]) ?? "human",
      authSource: (actor?.source as AuditEventInput["authSource"]) ?? "mcp",
      resourceType: "agent_template",
      resourceId: templateId,
      operation: "read",
      decision: "denied",
      policyVersion: POLICY_VERSION,
    });
    return { error: `Template not found: ${templateId}` };
  }
  return template;
}
