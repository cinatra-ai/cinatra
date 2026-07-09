import "server-only";

// ---------------------------------------------------------------------------
// Uniform extension access evaluator.
//
// ONE enforcement entry the installer / render / dispatch / MCP-use / teardown
// paths call for EVERY extension kind (agent / connector / skill / artifact /
// workflow). Brings connector / artifact / workflow up to the polymorphic
// access model agents already use (extension_access_policy + extension_co_owners),
// replacing the per-kind `enforceConnectorPolicy` / ad-hoc gates.
//
// Design:
//   • `evaluateExtensionAccess(...)` is PURE (no I/O) — fully unit-testable.
//   • `enforceExtensionAccess(...)` / `canExtensionAccess(...)` resolve the
//     policy + co-owners + installer via permissions-store, then call the pure
//     evaluator.
//   • Kind-aware ADMIN-STANDING short-circuit: an admin of the extension's
//     owning scope (`hasAdminStandingOverExtension`) is admitted INDEPENDENT of
//     the stored visibility tier / installer pointer — automatically, by role,
//     so a newly-promoted admin needs no per-row grant and a demotion reverts
//     it. Carve-outs: `connection` excludes use/execute (using another user's
//     credential stays an explicit owner share; the per-connection use-gate's
//     vendor `only` ceiling clamp governs use), and `agent_run` is manage-only
//     (run data stays owner-private).
//
// CORRECTNESS NOTE: the `"admin"` visibility
// tier here is OWNER-AWARE — for an org-owned extension it allows the owning
// org's org_owner/org_admin (and platform_admin), NOT platform_admin-only.
// This intentionally DIVERGES from the agent run path's `policyAllows()`
// (`packages/agents/src/auth-policy.ts`), where `"admin"` means platform_admin
// only. The agent run path is deliberately left UNCHANGED — connectors'
// legacy `visibility="admin"` meant "org admins of this org", and preserving
// that is required so org admins do not lose connector read/use access.
//
// The cross-org guard is inlined here (same rule the kernel `can()` applies:
// a non-platform-admin actor of a different org is denied) rather than routed
// through `can()`, because there is no per-extension Permission in the authz
// registry to evaluate against. The visibility-tier evaluation below is the
// access decision; the cross-org guard is the safety net underneath it.
// ---------------------------------------------------------------------------

import { AuthzError } from "@/lib/authz";
import type { ActorContext } from "@/lib/authz";
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
  AgentAuthPolicyVisibilitySelection,
} from "@cinatra-ai/agents/auth-policy";

import type { ExtensionKind } from "./permissions-kind-hooks";
import type { ExtensionOwnerLevel } from "./canonical-types";
import {
  readExtensionAccessPolicy,
  readExtensionCoOwners,
  readExtensionInstalledBy,
} from "./permissions-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Uniform access operations across all kinds. Mapped to policy visibility
 * fields below:
 *   list    -> runListVisibility
 *   read    -> runDataVisibility
 *   use     -> runDataVisibility   (connector "use" = read-tier consumption)
 *   execute -> runExecuteVisibility
 *   share   -> allowRunSharing gate, then runDataVisibility
 *   manage  -> who-can-edit-the-policy gate (admin / installer / co-owner)
 */
export type ExtensionAccessOp =
  | "list"
  | "read"
  | "use"
  | "execute"
  | "share"
  | "manage";

/**
 * The minimum owner context the evaluator needs. Mirrors the canonical
 * `installed_extension` row (owner_level / owner_id / organization_id).
 */
export type ExtensionOwnerContext = {
  ownerLevel: ExtensionOwnerLevel;
  ownerId: string | null;
  organizationId: string | null;
};

export type ExtensionAccessDenyReason =
  | "no_actor"
  | "cross_org"
  | "not_visible"
  | "manage_requires_admin";

export type ExtensionAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: ExtensionAccessDenyReason };

/**
 * Resolved inputs for the pure evaluator. The async wrappers below produce
 * this from the polymorphic store; tests can construct it directly.
 */
export type EvaluateExtensionAccessInput = {
  /**
   * The extension kind — selects the kind-aware admin-standing op set
   * (connection excludes use/execute; agent_run is manage-only; every other
   * kind grants full parity). Threaded through from the async wrappers'
   * {@link ExtensionAccessResource.kind}.
   */
  kind: ExtensionKind;
  policy: AgentAuthPolicy;
  coOwnerUserIds: string[];
  installedByUserId: string | null;
  owner: ExtensionOwnerContext;
  actor: ActorContext | undefined | null;
  op: ExtensionAccessOp;
};

/**
 * Locator for the async wrappers: identifies the canonical polymorphic row
 * (resource_kind + resource_id) plus the owner context for tier evaluation.
 */
export type ExtensionAccessResource = {
  kind: ExtensionKind;
  resourceId: string;
  owner: ExtensionOwnerContext;
  /**
   * Fallback policy applied when no `extension_access_policy` row exists for
   * the resource. Defaults to {@link DEFAULT_EXTENSION_ACCESS_POLICY}.
   */
  fallbackPolicy?: AgentAuthPolicy;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default access for an installed extension with no stored policy. Workspace
 * visibility = every same-org member may list/read/use/execute; sharing
 * disabled by default. Install-time callers (setExtensionInstallAccess) may
 * override per kind.
 */
export const DEFAULT_EXTENSION_ACCESS_POLICY: AgentAuthPolicy = Object.freeze({
  // Multi-scope W1: non-empty token arrays; inner arrays frozen (shared default).
  runListVisibility: Object.freeze(["workspace"]),
  runDataVisibility: Object.freeze(["workspace"]),
  runExecuteVisibility: Object.freeze(["workspace"]),
  allowRunSharing: false,
}) as unknown as AgentAuthPolicy;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanUserId(actor: ActorContext): string | undefined {
  return actor.principalType === "HumanUser" ? actor.principalId : undefined;
}

function isPlatformAdmin(actor: ActorContext): boolean {
  return actor.platformRole === "platform_admin";
}

/**
 * Shared ADMIN-STANDING predicate — "does this actor hold admin standing over
 * the extension's owning scope?". True for platform admins (every extension in
 * the instance), and for the org_owner/org_admin of the EXTENSION's owning
 * organization. Org-anchored user / team / organization owner levels all carry
 * that org on `owner.organizationId` (the M1 org-anchor backfill), so keying on
 * `organizationId` covers all three. For a workspace/platform-owned extension
 * with NO organization, only platform admins qualify (there is no org to be an
 * admin of) — fail closed.
 *
 * This is the role-derived standing the evaluator short-circuits on: it is
 * independent of the installer pointer, the stored visibility tier, and
 * co-owner grants, so it applies automatically to a newly-promoted admin (no
 * per-row grant writes) and reverts on demotion. Exported so the write-surface
 * callers (permission actions, skills page-data, the connection kind hook)
 * apply the identical standing rule.
 */
export function hasAdminStandingOverExtension(
  actor: ActorContext,
  owner: ExtensionOwnerContext,
): boolean {
  if (isPlatformAdmin(actor)) return true;
  if (
    owner.organizationId &&
    actor.organizationId === owner.organizationId &&
    (actor.orgRole === "org_owner" || actor.orgRole === "org_admin")
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Kind-aware admin-standing op sets.
//
// Which ops ADMIN STANDING grants directly, per kind, as a short-circuit AFTER
// the cross-org guard (independent of the stored visibility tier / installer
// pointer):
//   • every kind EXCEPT the two below → all six ops (full parity).
//   • connection → list / read / manage ONLY, never use/execute: using another
//     user's credential stays an explicit owner share, and the per-connection
//     use-gate's vendor `only` ceiling clamp governs use.
//   • agent_run → manage ONLY: run data (chat/execution content) stays
//     owner-private; an admin never gains read/use/execute over another user's
//     run.
// `manage` is in every set, so the manage branch is unchanged by kind.
// ---------------------------------------------------------------------------

const ALL_ADMIN_STANDING_OPS: ReadonlySet<ExtensionAccessOp> = new Set([
  "list",
  "read",
  "use",
  "execute",
  "share",
  "manage",
]);
const CONNECTION_ADMIN_STANDING_OPS: ReadonlySet<ExtensionAccessOp> = new Set([
  "list",
  "read",
  "manage",
]);
const AGENT_RUN_ADMIN_STANDING_OPS: ReadonlySet<ExtensionAccessOp> = new Set([
  "manage",
]);

/**
 * The ops admin standing grants for a kind (see the table above). A pure lookup
 * — the cross-org / owner-private carve-outs are encoded in the returned set.
 */
export function adminStandingOps(
  kind: ExtensionKind,
): ReadonlySet<ExtensionAccessOp> {
  switch (kind) {
    case "connection":
      return CONNECTION_ADMIN_STANDING_OPS;
    case "agent_run":
      return AGENT_RUN_ADMIN_STANDING_OPS;
    default:
      return ALL_ADMIN_STANDING_OPS;
  }
}

function visibilityFieldForOp(
  op: Exclude<ExtensionAccessOp, "manage">,
  policy: AgentAuthPolicy,
): AgentAuthPolicyVisibilitySelection {
  // Multi-scope W2: fields are NON-EMPTY token arrays (a union of grants). This
  // returns the whole selection; the caller admits the actor if ANY token
  // admits them (`tokens.some(visibilityAllows)`). A single-token field (every
  // writer until the W3 multi-select picker) reduces to the exact pre-array
  // scalar decision, so this can neither over- nor under-grant an existing
  // policy.
  switch (op) {
    case "list":
      return policy.runListVisibility;
    case "read":
    case "use":
      return policy.runDataVisibility;
    case "execute":
      return policy.runExecuteVisibility;
    case "share":
      // share follows runDataVisibility AFTER the allowRunSharing gate (handled
      // by the caller); reaching here means sharing is allowed.
      return policy.runDataVisibility;
    default: {
      const _exhaustive: never = op;
      throw new Error(
        `visibilityFieldForOp: unhandled op: ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * Per-token visibility predicate — the single-token `matchOne` the any-match
 * matcher in {@link evaluateExtensionAccess} folds over each op's token
 * selection (`tokens.some(visibilityAllows)`). Does this ONE tier admit the
 * actor? Runs AFTER the cross-org guard + owner/co-owner short-circuits, so an
 * anonymous or different-org actor never reaches here. Mirrors the agent
 * `policyAllows()` tiers EXCEPT the owner-aware `"admin"` branch (see file
 * header).
 */
function visibilityAllows(
  visibility: AgentAuthPolicyVisibility,
  actor: ActorContext,
  owner: ExtensionOwnerContext,
): boolean {
  if (isPlatformAdmin(actor)) return true;
  if (visibility === "owner") return false; // owner handled by short-circuit
  if (visibility === "workspace") return true; // same-org guaranteed upstream
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
  if (visibility === "admin") return hasAdminStandingOverExtension(actor, owner); // OWNER-AWARE
  if (visibility === "org") return true; // any same-org member (guard passed)
  // Fail closed on any unrecognized visibility value. Stored policies are
  // zod-validated at write time (setExtensionInstallAccess), so an unknown
  // value here means corruption / a bypassed writer — deny rather than fall
  // through to the agent path's permissive "org" default.
  return false;
}

// ---------------------------------------------------------------------------
// Pure evaluator
// ---------------------------------------------------------------------------

export function evaluateExtensionAccess(
  input: EvaluateExtensionAccessInput,
): ExtensionAccessDecision {
  const { kind, policy, coOwnerUserIds, installedByUserId, owner, actor, op } =
    input;

  if (!actor) return { allowed: false, reason: "no_actor" };

  // platform_admin bypasses every gate (kernel parity).
  if (isPlatformAdmin(actor)) return { allowed: true };

  // Cross-org guard: a non-platform-admin actor is denied on an org-anchored
  // extension unless their org matches (same rule the kernel can() applies).
  // An actor with NO organizationId is denied on an org-owned extension — fail
  // closed, matching the kernel (undefined org != owner org). This runs BEFORE
  // the admin-standing / owner / co-owner short-circuits so a cross-org (or
  // org-less) admin / installer / co-owner cannot slip past the guard.
  if (owner.organizationId && actor.organizationId !== owner.organizationId) {
    return { allowed: false, reason: "cross_org" };
  }

  const uid = humanUserId(actor);
  const ownerMatch =
    uid != null &&
    (uid === installedByUserId ||
      (owner.ownerLevel === "user" && uid === owner.ownerId));
  const coOwnerMatch = uid != null && coOwnerUserIds.includes(uid);
  const adminStanding = hasAdminStandingOverExtension(actor, owner);
  const adminOps = adminStandingOps(kind);

  // manage: editing the access policy / granting co-owners. Allowed for an
  // admin with standing (every kind grants admins `manage`), the installer
  // (primary owner), and co-owners. Preserves the legacy connector "manage
  // requires org admin" property while also letting the installer manage their
  // own extension.
  if (op === "manage") {
    if ((adminStanding && adminOps.has("manage")) || ownerMatch || coOwnerMatch) {
      return { allowed: true };
    }
    return { allowed: false, reason: "manage_requires_admin" };
  }

  // ADMIN-STANDING short-circuit (kind-aware, role-derived). An admin of the
  // extension's owning scope gets admin-level access INDEPENDENT of the stored
  // visibility tier and the installer pointer — the automatic parity this epic
  // delivers, so a same-org admin is admitted on OWNER-default (and
  // team/project/org-restricted) rows they did not install. The kind carve-outs
  // live in adminStandingOps: `connection` omits use/execute, `agent_run` grants
  // nothing here (its `manage` was handled above), every other kind grants
  // list/read/use/execute/share.
  if (adminStanding && adminOps.has(op)) return { allowed: true };

  // Owner / co-owner short-circuit for list/read/use/execute/share. These are
  // the resource's trusted parties (share ∈ COOWNER_OPS in the agent model),
  // so they may act on every access op regardless of visibility tier or the
  // allowRunSharing flag. Runs BEFORE the share gate so a co-owner is not
  // wrongly blocked when allowRunSharing=false.
  if (ownerMatch || coOwnerMatch) return { allowed: true };

  // share by a non-owner / non-co-owner / non-admin-with-share-standing is gated
  // by allowRunSharing. An admin WITH share standing (most kinds) was already
  // admitted by the short-circuit above; a connection/agent_run admin has no
  // share standing and is gated here exactly like a plain member.
  if (op === "share" && !policy.allowRunSharing) {
    return { allowed: false, reason: "not_visible" };
  }

  // Remaining ops (a member's list/read/use/execute, an allowed share, and the
  // read/use/execute of a carve-out kind's admin) are subject to the visibility
  // tier. ANY-MATCH (multi-scope W2): the actor is admitted iff SOME token in
  // the op's selection admits them. The owner-aware "admin" tier in
  // visibilityAllows() still admits an owning-org admin where a policy
  // explicitly stores "admin".
  const tokens = visibilityFieldForOp(op, policy);
  if (tokens.some((v) => visibilityAllows(v, actor, owner))) {
    return { allowed: true };
  }
  return { allowed: false, reason: "not_visible" };
}

// ---------------------------------------------------------------------------
// Async wrappers (resolve policy + co-owners + installer from the store)
// ---------------------------------------------------------------------------

async function resolveDecision(
  resource: ExtensionAccessResource,
  actor: ActorContext | undefined | null,
  op: ExtensionAccessOp,
): Promise<ExtensionAccessDecision> {
  const [policy, coOwners, installedBy] = await Promise.all([
    readExtensionAccessPolicy(resource.kind, resource.resourceId),
    readExtensionCoOwners(resource.kind, resource.resourceId),
    readExtensionInstalledBy(resource.kind, resource.resourceId),
  ]);
  return evaluateExtensionAccess({
    kind: resource.kind,
    policy:
      policy ?? resource.fallbackPolicy ?? DEFAULT_EXTENSION_ACCESS_POLICY,
    coOwnerUserIds: coOwners.map((c) => c.userId),
    installedByUserId: installedBy,
    owner: resource.owner,
    actor,
    op,
  });
}

/**
 * Predicate variant — never throws. Use for UI gating / list filtering.
 */
export async function canExtensionAccess(
  resource: ExtensionAccessResource,
  actor: ActorContext | undefined | null,
  op: ExtensionAccessOp,
): Promise<ExtensionAccessDecision> {
  return resolveDecision(resource, actor, op);
}

/**
 * Enforcing variant — resolves silently on allow, throws AuthzError on deny.
 * 403 forbidden for visibility/manage denials, 404 hidden for cross-org
 * (don't leak existence across orgs), 401 for a missing actor.
 */
export async function enforceExtensionAccess(
  resource: ExtensionAccessResource,
  actor: ActorContext | undefined | null,
  op: ExtensionAccessOp,
): Promise<void> {
  const decision = await resolveDecision(resource, actor, op);
  if (decision.allowed) return;
  if (decision.reason === "no_actor") {
    throw new AuthzError({
      statusCode: 401,
      reason: "no_session",
      message: "Extension access requires an authenticated actor.",
    });
  }
  if (decision.reason === "cross_org") {
    throw new AuthzError({
      statusCode: 404,
      reason: "hidden",
      message: "Extension not found.",
    });
  }
  throw new AuthzError({
    statusCode: 403,
    reason: "forbidden",
    message: `Extension access denied (${decision.reason}).`,
  });
}
