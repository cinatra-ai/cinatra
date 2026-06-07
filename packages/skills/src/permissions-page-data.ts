import "server-only";

// ---------------------------------------------------------------------------
// Server-side helpers that fetch everything the generic PermissionsForm
// widget needs for a skill_package permissions panel.
//
// Mirrors the agent-run pattern in packages/agents/src/instance-screens.tsx
// (lines ~495-540) — resolves orgs/teams/projects from Better Auth + the
// kernel role + the actor's view of canGrantWorkspace.
// ---------------------------------------------------------------------------

import { eq, inArray } from "drizzle-orm";

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForSession,
} from "@/lib/auth-session";
import {
  betterAuthDb,
  betterAuthUsers,
  readOrgsWithTeamsForUser,
  readProjectsForUser,
} from "@/lib/better-auth-db";

import {
  readSkillPackageAccessPolicy,
  readSkillPackageCoOwners,
  readSkillPackageInstalledBy,
} from "./skills-store";

import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";

export type SkillPackagePermissionsOwnerView = {
  userId: string;
  name: string;
  email: string;
  image: string | null;
};

export type SkillPackagePermissionsContext = {
  packageId: string;
  /**
   * True iff the actor is an admin / installer / co-owner of this package.
   * When false, the page must NOT render the permissions panel (owner /
   * co-owner list / access policy are admin-config data, not public).
   *
   * For strict mode, `canRead === canEdit` — anyone allowed to see the
   * config is also allowed to edit it.
   */
  canRead: boolean;
  canEdit: boolean;
  isAdmin: boolean;
  currentUserId: string | null;
  initialPolicy: AgentAuthPolicy;
  owner: SkillPackagePermissionsOwnerView | null;
  coOwners: SkillPackagePermissionsOwnerView[];
  availableScopes: {
    orgs: Array<{ id: string; name: string; teams: Array<{ id: string; name: string }> }>;
    projects: Array<{ id: string; name: string }>;
    canGrantWorkspace: boolean;
  };
};

/**
 * Default policy applied when the package has no policy persisted yet.
 * Mirrors the agent-template default — "owner" visibility, sharing enabled.
 */
function buildDefaultPolicy(): AgentAuthPolicy {
  return {
    runListVisibility: "owner",
    runDataVisibility: "owner",
    runExecuteVisibility: "owner",
    allowRunSharing: true,
  };
}

async function resolveOwnerView(
  userId: string | null,
): Promise<SkillPackagePermissionsOwnerView | null> {
  if (!userId) return null;
  const [row] = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      email: betterAuthUsers.email,
      image: betterAuthUsers.image,
    })
    .from(betterAuthUsers)
    .where(eq(betterAuthUsers.id, userId))
    .limit(1);
  if (!row) return null;
  return {
    userId: row.id,
    name: row.name ?? row.email ?? "Unknown",
    email: row.email ?? "",
    image: row.image,
  };
}

async function resolveCoOwnerViews(
  packageId: string,
): Promise<SkillPackagePermissionsOwnerView[]> {
  const rows = await readSkillPackageCoOwners(packageId);
  if (rows.length === 0) return [];
  const userIds = rows.map((r) => r.userId);
  const userRows = await betterAuthDb
    .select({
      id: betterAuthUsers.id,
      name: betterAuthUsers.name,
      email: betterAuthUsers.email,
      image: betterAuthUsers.image,
    })
    .from(betterAuthUsers)
    .where(inArray(betterAuthUsers.id, userIds));
  const byId = new Map(userRows.map((u) => [u.id, u]));
  return rows
    .map((r) => {
      const u = byId.get(r.userId);
      if (!u) return null;
      return {
        userId: u.id,
        name: u.name ?? u.email ?? "Unknown",
        email: u.email ?? "",
        image: u.image,
      } satisfies SkillPackagePermissionsOwnerView;
    })
    .filter((x): x is SkillPackagePermissionsOwnerView => x !== null);
}

export async function loadSkillPackagePermissionsContext(
  packageId: string,
): Promise<SkillPackagePermissionsContext> {
  const session = await requireAuthSession();
  const actorUserId = session.user?.id ?? null;
  const isAdmin = isPlatformAdmin(session);

  const installedBy = await readSkillPackageInstalledBy(packageId);

  // canEdit gate mirrors the server-action gate in permissions-actions.ts.
  let canEdit = isAdmin;
  if (!canEdit && actorUserId) {
    if (installedBy === actorUserId) {
      canEdit = true;
    } else {
      const coOwners = await readSkillPackageCoOwners(packageId);
      canEdit = coOwners.some((c) => c.userId === actorUserId);
    }
  }

  // Strict read: canRead === canEdit for skill-package admin config. Anyone
  // allowed to see is also allowed to edit. If !canRead, return a stripped
  // context: no owner / co-owners / policy leak past the gate. The caller MUST
  // check `canRead` before mounting the permissions panel.
  const canRead = canEdit;
  if (!canRead) {
    return {
      packageId,
      canRead,
      canEdit,
      isAdmin,
      currentUserId: actorUserId,
      initialPolicy: buildDefaultPolicy(),
      owner: null,
      coOwners: [],
      availableScopes: { orgs: [], projects: [], canGrantWorkspace: false },
    } satisfies SkillPackagePermissionsContext;
  }

  const owner = await resolveOwnerView(installedBy);
  const coOwners = await resolveCoOwnerViews(packageId);
  const accessPolicy = await readSkillPackageAccessPolicy(packageId);

  const orgs = actorUserId ? await readOrgsWithTeamsForUser(actorUserId) : [];
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  const projects =
    actorUserId && activeOrgId
      ? await readProjectsForUser(actorUserId, activeOrgId)
      : [];

  const orgRole = actorUserId
    ? await resolveOrgRoleForSession({
        user: { id: actorUserId },
        session: session.session,
      })
    : undefined;
  const canGrantWorkspace =
    isAdmin || orgRole === "org_owner" || orgRole === "org_admin";

  return {
    packageId,
    canRead,
    canEdit,
    isAdmin,
    currentUserId: actorUserId,
    initialPolicy: accessPolicy ?? buildDefaultPolicy(),
    owner,
    coOwners,
    availableScopes: { orgs, projects, canGrantWorkspace },
  };
}

// ---------------------------------------------------------------------------
// Per-skill permissions context loader.
//
// Falls back to the parent package's accessPolicy when the skill row has no
// override, so the read-side default matches what an operator visiting the
// skill detail page expects. Auth gate (canEdit) is keyed on the parent
// package's installer/co-owner/admin set (skills aren't user-authored).
// ---------------------------------------------------------------------------

import {
  readSkillAccessPolicy,
  readSkillCoOwners,
  readSkillPackageIdFor,
} from "./skills-store";

export type SkillPermissionsContext = SkillPackagePermissionsContext & {
  /** Override target — the skill id. Distinct from `packageId` (parent). */
  skillId: string;
};

export async function loadSkillPermissionsContext(
  skillId: string,
): Promise<SkillPermissionsContext | null> {
  const packageId = await readSkillPackageIdFor(skillId);
  if (!packageId) return null;

  // Reuse the package-level loader for session + scopes + admin checks +
  // package-level owner/co-owner views. The skill-level override layers on
  // top: accessPolicy falls through to the package's policy when null;
  // coOwners is unioned with the package's coOwners so the operator sees
  // both layers in the same list (de-duped by userId).
  const packageContext = await loadSkillPackagePermissionsContext(packageId);

  // The package-level loader's canRead misses skill-level co-owners (people
  // who are NOT installers / package co-owners / admins but ARE skill-level
  // co-owners). The write-side gate `isPackageInstallerOrCoOwnerOrAdminForSkill`
  // admits them; the read-side must too, otherwise they can't load the same
  // panel they're allowed to edit. Resolve a skill-level canRead by checking
  // the skill_co_owners table when packageContext.canRead is false.
  const skillCoOwnerRows = await readSkillCoOwners(skillId);
  const isSkillCoOwner =
    packageContext.currentUserId != null &&
    skillCoOwnerRows.some((c) => c.userId === packageContext.currentUserId);
  const canRead = packageContext.canRead || isSkillCoOwner;

  // Strict-read short-circuit (Decision 2): no policy + no co-owner views
  // past the gate. Skill-level data fetched above (the rows themselves) is
  // already loaded; not leaking — we just don't surface it.
  if (!canRead) {
    return {
      ...packageContext,
      canRead: false,
      packageId,
      skillId,
      coOwners: [],
      owner: null,
    };
  }

  // Skill-level co-owners get the same canEdit as the action gate allows.
  const skillCanEdit = packageContext.canEdit || isSkillCoOwner;
  const skillAccessPolicy = await readSkillAccessPolicy(skillId);

  // Resolve the skill-level co-owners to OwnerView via the same BetterAuth
  // lookup used for package co-owners. Hoist into a small inline helper so
  // we don't re-import the same shape; uses `inArray` from drizzle-orm.
  const skillCoOwnerViews = await (async (): Promise<SkillPackagePermissionsOwnerView[]> => {
    if (skillCoOwnerRows.length === 0) return [];
    const userIds = skillCoOwnerRows.map((r) => r.userId);
    const userRows = await betterAuthDb
      .select({
        id: betterAuthUsers.id,
        name: betterAuthUsers.name,
        email: betterAuthUsers.email,
        image: betterAuthUsers.image,
      })
      .from(betterAuthUsers)
      .where(inArray(betterAuthUsers.id, userIds));
    const byId = new Map(userRows.map((u) => [u.id, u]));
    return skillCoOwnerRows
      .map((r) => {
        const u = byId.get(r.userId);
        if (!u) return null;
        return {
          userId: u.id,
          name: u.name ?? u.email ?? "Unknown",
          email: u.email ?? "",
          image: u.image,
        } satisfies SkillPackagePermissionsOwnerView;
      })
      .filter((x): x is SkillPackagePermissionsOwnerView => x !== null);
  })();

  // The skill panel exposes ONLY the skill-level co-owners. Merging
  // skill-level + package-level co-owners creates a UX leak:
  // removeSkillCoOwner only deletes rows from cinatra.skill_co_owners, so
  // clicking remove on a package-inherited entry would appear to succeed
  // locally but reappear on refresh. Package-level owners stay visible on the
  // parent-package detail page.
  return {
    ...packageContext,
    canRead,
    canEdit: skillCanEdit,
    packageId,
    skillId,
    // Use the skill-level override when set; else inherit the package's policy.
    initialPolicy: skillAccessPolicy ?? packageContext.initialPolicy,
    coOwners: skillCoOwnerViews,
    // No per-skill primary owner column to mutate; suppressing the owner
    // row keeps the form's Remove button from rendering against a
    // non-existent target.
    owner: null,
  };
}
