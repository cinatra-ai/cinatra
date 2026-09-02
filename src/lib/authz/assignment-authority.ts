// ---------------------------------------------------------------------------
// The ONE shared exact-scope resolver for per-scope assignment authority
// (cinatra#2813 S1, epic #2812).
//
// The epic states the rule in one sentence: "whoever writes an assignment must
// administer the scope it affects". Both new permissions —
// `agent.assignments.manage` (skills) and `context.assign` (artifacts) — are
// enforced through THIS function, so the skills surface and the artifacts
// surface cannot answer the same question differently.
//
// WHY NOT THE KERNEL'S ROLE CHECK ALONE. `can(actor, "agent.assignments.manage")`
// answers "does this person hold the permission anywhere", and an assignment
// row is never "anywhere" — it belongs to one organization, one team, one
// project, or one person. An org admin of org A holding the permission must not
// be able to write org B's rows, and a team admin must not reach a team they do
// not administer just because the permission was granted at the organization
// level. So the permission is the ADMISSION and this resolver is the FENCE, and
// the fence reads the exact scope out of the actor's own bulk-resolved grants:
// `orgRole` against `organizationId`, `teamRoles[scopeId]`, the project grant
// for `scopeId`, and — for a personal row — plain identity.
//
// WORKSPACE HAS NO GRANT ROAD. No role grants workspace authority, not even
// org_owner: a workspace row applies to every organization on the instance, and
// nothing below the platform can decide that. A platform admin reaches it only
// through `withPlatformAdminBypass` with the `workspace_configuration` reason,
// which writes the audit row BEFORE the mutation. The same is true of a
// platform admin writing at organization/team/project scope, which takes the
// sibling `scope_configuration` reason. That is why this resolver gives a
// platform admin nothing: an unaudited platform-admin write is exactly what the
// bypass convention exists to prevent, and a silent shortcut here would be one.
//
// To be exact about what that means: the PLATFORM ROLE contributes nothing
// here. It does not follow that a person who holds it is refused — if they are
// independently the org_admin of the organization the row belongs to, they are
// admitted AS that org admin, `via: "organization_admin"`, on exactly the road
// every other org admin takes. What they never get is authority they hold only
// because they are a platform admin; that road is the audited bypass.
//
// READS NEVER REQUIRE WRITE AUTHORITY. `resolveAssignmentReadAuthority` is a
// membership question, not an administration one — a person who belongs to a
// team sees what that team assigned and can change none of it. The two are
// separate functions rather than one function with a flag so a caller cannot
// pass the wrong flag and widen a write.
// ---------------------------------------------------------------------------
import type { ActorContext } from "./actor-context";
import { evaluateAssignmentScope, type AssignmentScope } from "@/lib/assignment-scope";

/** How the write was authorized. Recorded on the audit envelope by callers. */
export type AssignmentAuthorityVia =
  | "organization_owner"
  | "organization_admin"
  | "team_admin"
  | "project_owner"
  | "project_admin"
  | "personal_self";

export type AssignmentAuthorityRefusal =
  | "invalid-scope"
  | "workspace-requires-audited-bypass"
  | "scope-outside-actor-organization"
  | "not-an-organization-admin"
  | "not-a-team-admin"
  | "not-a-project-admin"
  | "not-self";

export type AssignmentWriteDecision =
  | { allowed: true; via: AssignmentAuthorityVia }
  | { allowed: false; reason: AssignmentAuthorityRefusal };

export type AssignmentReadDecision =
  | { allowed: true }
  | { allowed: false; reason: AssignmentAuthorityRefusal };

/** The scope tuple as the callers hold it, before validation. */
type LooseScope = { scopeKind: string; scopeId: string } | AssignmentScope;

function validate(scope: LooseScope): AssignmentScope | null {
  const verdict = evaluateAssignmentScope(scope);
  return verdict.ok ? verdict.scope : null;
}

/**
 * May this actor WRITE assignment rows at exactly this scope?
 *
 * Fail-closed at every branch: an unresolvable scope, an unresolved grant axis
 * (`projectGrants` left `undefined` by a caller that never resolved it), and an
 * unknown kind all refuse.
 */
export function resolveAssignmentWriteAuthority(
  actor: ActorContext,
  scope: LooseScope,
): AssignmentWriteDecision {
  const valid = validate(scope);
  if (!valid) return { allowed: false, reason: "invalid-scope" };

  switch (valid.scopeKind) {
    case "workspace":
      // Deliberately unconditional — see the module doc.
      return { allowed: false, reason: "workspace-requires-audited-bypass" };

    case "organization": {
      // The EXACT organization, not "an organization this person administers
      // somewhere": the actor context carries one active organization and the
      // roles are relative to it.
      if (actor.organizationId !== valid.scopeId) {
        return { allowed: false, reason: "scope-outside-actor-organization" };
      }
      if (actor.orgRole === "org_owner") return { allowed: true, via: "organization_owner" };
      if (actor.orgRole === "org_admin") return { allowed: true, via: "organization_admin" };
      return { allowed: false, reason: "not-an-organization-admin" };
    }

    case "team": {
      // `teamMember.role` is the axis; membership alone is not authority.
      if (actor.teamRoles?.[valid.scopeId] === "team_admin") {
        return { allowed: true, via: "team_admin" };
      }
      return { allowed: false, reason: "not-a-team-admin" };
    }

    case "project": {
      // The project-access ranks are read < write < admin < owner. Only the top
      // two administer; `write` is authority over the project's WORK, not over
      // the configuration that decides what its agents carry.
      const grant = actor.projectGrants?.find((g) => g.projectId === valid.scopeId);
      if (grant?.effectiveRole === "owner") return { allowed: true, via: "project_owner" };
      if (grant?.effectiveRole === "admin") return { allowed: true, via: "project_admin" };
      return { allowed: false, reason: "not-a-project-admin" };
    }

    case "user": {
      // An identity rule, not a permission: a person's own assignments are
      // theirs, and nobody else's — an organization admin and a platform admin
      // are both refused here (the platform admin takes the audited bypass).
      if (actor.principalId && actor.principalId === valid.scopeId) {
        return { allowed: true, via: "personal_self" };
      }
      return { allowed: false, reason: "not-self" };
    }
  }
}

/**
 * May this actor READ assignment rows at exactly this scope?
 *
 * Membership, never administration. The workspace tier is readable by anyone
 * with a context at all — it is the instance-wide default every run already
 * carries — and the other four are fenced to the actor's own organization,
 * teams, projects and identity.
 */
export function resolveAssignmentReadAuthority(
  actor: ActorContext,
  scope: LooseScope,
): AssignmentReadDecision {
  const valid = validate(scope);
  if (!valid) return { allowed: false, reason: "invalid-scope" };

  switch (valid.scopeKind) {
    case "workspace":
      return { allowed: true };

    case "organization":
      return actor.organizationId === valid.scopeId
        ? { allowed: true }
        : { allowed: false, reason: "scope-outside-actor-organization" };

    case "team":
      // Any role on the team, `member` included.
      return actor.teamIds?.includes(valid.scopeId)
        ? { allowed: true }
        : { allowed: false, reason: "not-a-team-admin" };

    case "project":
      // Any grant on the project, `read` included.
      return actor.projectGrants?.some((g) => g.projectId === valid.scopeId)
        ? { allowed: true }
        : { allowed: false, reason: "not-a-project-admin" };

    case "user":
      return actor.principalId === valid.scopeId
        ? { allowed: true }
        : { allowed: false, reason: "not-self" };
  }
}

/**
 * The audited-bypass reason a platform admin's write at this scope takes.
 *
 * Two reasons rather than one because the audit row must say WHICH: a
 * workspace-wide configuration change and a change inside one organization are
 * different acts with different blast radii, and an auditor reading a single
 * reason could not tell them apart.
 */
export function platformAdminBypassReasonForScope(
  scope: LooseScope,
): "workspace_configuration" | "scope_configuration" | null {
  const valid = validate(scope);
  if (!valid) return null;
  return valid.scopeKind === "workspace" ? "workspace_configuration" : "scope_configuration";
}
