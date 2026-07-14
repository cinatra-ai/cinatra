import "server-only";

// ---------------------------------------------------------------------------
// Install-target authorization helpers — SHARED between the agent registry
// install path (packages/agents/src/actions.ts:installRegistryPackageAtScope)
// and the extension marketplace install path
// (packages/extensions/src/actions.ts:installExtensionPackageFormAction).
//
// Moved VERBATIM out of packages/agents/src/actions.ts so both server actions
// enforce ONE rule grid (no second parallel implementation to drift). The
// client pickers' disabled rows are a UX affordance only; these helpers are
// the actual security boundary and MUST stay fail-closed.
//
// The rule grid is mirrored (for picker row enabled/disabled state) by
// `buildInstallTargets` in ./install-targets.ts, with
// src/__tests__/install-targets-parity.test.ts enforcing parity.
// ---------------------------------------------------------------------------

import { AuthzError } from "@/lib/authz";
import { readProjectById } from "@/lib/projects-store-dao";
import { readProjectCoOwners } from "@/lib/project-co-owners-store";
import { readTeamForOrg } from "@/lib/better-auth-db";

export type InstallScopeTarget = {
  // "workspace" / "admin" are extension-install audience scopes (cinatra#1527):
  // both are platform-admin-only to install. They are NOT valid targets for the
  // agent at-scope install path (installRegistryPackageAtScope), whose Zod
  // schema still restricts to organization/team/project — a widened SHARED type
  // lets this one gate reason about all five while each caller's own schema
  // decides which levels it will admit. The workspace itself is derived
  // canonically from the authenticated tenant, never a client-supplied id.
  level: "organization" | "team" | "project" | "workspace" | "admin";
  id: string;
};

export type InstallActorRoleBag = {
  principalId: string;
  organizationId: string;
  platformRole?: "platform_admin" | "member";
  orgRole?: "org_owner" | "org_admin" | "member";
  teamRoles?: Record<string, "team_admin" | "member">;
};

export type ProjectOwnershipContext = {
  ownerUserIds: Set<string>;
  owningTeamId: string | null;
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
 *  - workspace / admin (cinatra#1527): platform_admin ONLY. Every other role —
 *             org_owner, org_admin, team_admin, member — is DENIED. (Install
 *             AUTHORITY only; the post-install AUDIENCE is a separate decision
 *             carried by the mapped AgentAuthPolicy visibility tokens.)
 */
export async function assertCanInstallAtTarget(
  actor: InstallActorRoleBag,
  target: InstallScopeTarget,
  // For project target — looked up by caller (assertTargetBelongsToActiveOrg)
  // to avoid a second DB round-trip. If absent for project target, helper
  // fails closed.
  projectOwnership?: ProjectOwnershipContext,
): Promise<void> {
  const isPlatformAdmin = actor.platformRole === "platform_admin";
  if (isPlatformAdmin) return; // short-circuit

  // Workspace / admin install authority is platform-admin-only (cinatra#1527).
  // platform_admin already returned above, so any actor reaching here at these
  // levels is a non-platform-admin and MUST be denied — an EXPLICIT fail-closed
  // branch (never fall through to the project-ownership block, which would
  // deny with the wrong message).
  if (target.level === "workspace" || target.level === "admin") {
    throw new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message:
        target.level === "workspace"
          ? "Install at whole-workspace scope requires platform admin."
          : "Install at admins-only scope requires platform admin.",
    });
  }

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
 *  - team:    readTeamForOrg(target.id, activeOrgId) — filters by
 *             team.organizationId. Cross-org forged team ids return null.
 *  - project: readProjectById(target.id) → ProjectRecord with
 *             organization_id + (owner_level, owner_id) discriminated owner.
 *             Then readProjectCoOwners(projectId) for the co-owner set.
 *             cinatra.projects schema has NO "owning_team_id" column; the
 *             owning team is project.owner_id when project.owner_level === "team".
 */
export async function assertTargetBelongsToActiveOrg(
  actor: InstallActorRoleBag,
  target: InstallScopeTarget,
  activeOrgId: string,
): Promise<{ projectOwnership?: ProjectOwnershipContext }> {
  // Workspace / admin (cinatra#1527): the audience IS the authenticated tenant
  // itself. There is nothing to look up and — crucially — NO client-supplied id
  // to trust (a client-supplied workspace is a cross-tenant risk, issue AC3).
  // The canonical workspace is derived by the caller from the session's active
  // org; this tenant gate is a no-op that neither reads nor validates
  // target.id. Install AUTHORITY (platform-admin-only) is enforced separately
  // by assertCanInstallAtTarget.
  if (target.level === "workspace" || target.level === "admin") {
    return {};
  }

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
 * Resolve the role bag the install-target gates need from a Better Auth
 * session. Mirrors what auth-session.requireActorContext / canDo do, but
 * specialised for the install path so the caller has direct access to
 * platformRole / orgRole / teamRoles without going through the kernel
 * conversion. Note: Production today does NOT load teamRoles from any
 * canonical store (Better Auth's teamMember table has no role column); the
 * field is plumbed through for future wiring and is exercised only by the
 * matrix tests that mock this resolver.
 *
 * The session parameter is typed structurally (user.id + user.role) so this
 * stays a leaf module — any Better Auth session shape satisfies it.
 */
export function readActorRolesForInstall(
  session: { user: { id: string; role?: string | null } },
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
