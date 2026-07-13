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
    runListVisibility: ["owner"],
    runDataVisibility: ["owner"],
    runExecuteVisibility: ["owner"],
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
// Two ownership anchors, dispatched on the skill row's DURABLE identity:
//
//   • USER-AUTHORED (personal/custom) skills — `isCustomSkill === true` with a
//     persisted `ownerUserId` (cinatra#1416). Authority is the skill's OWN
//     ownership set: owner + skill-level co-owners + platform admin. The
//     shared "Custom Skills" pseudo-package (custom:personal-skills) is a
//     storage bucket, NOT an ownership anchor — its installer/co-owners must
//     never gain manage over other users' personal skills.
//
//   • PACKAGE-SHIPPED skills — authority keys on the parent package's
//     installer/co-owner/admin set, plus skill-level co-owners. Falls back to
//     the parent package's accessPolicy when the skill row has no override.
//
// Returns null only when the skill row cannot be anchored at all: not found,
// or a package-shipped row with no parent package.
// ---------------------------------------------------------------------------

import {
  readSkillAccessPolicy,
  readSkillCoOwners,
  readSkillPackageIdFor,
} from "./skills-store";
import { readSkillsCatalogSnapshot } from "./skill-packages";

export type SkillPermissionsContext = SkillPackagePermissionsContext & {
  /** Override target — the skill id. Distinct from `packageId` (parent). */
  skillId: string;
};

/**
 * Default policy for a skill that has no persisted override: personal skills
 * default to owner-only (the personal baseline — nothing is ever
 * auto-promoted); package skills inherit via the package loader instead.
 */
function buildOwnerOnlyPolicy(): AgentAuthPolicy {
  return buildDefaultPolicy();
}

/**
 * ONE ownership model for the loader AND the policy-write actions
 * (cinatra#1416, AC2): may `actorUserId` manage this skill's access
 * configuration? platform admin ∨ durable owner (user-authored rows) ∨
 * skill-level co-owner ∨ (package-shipped rows only) parent-package
 * installer / co-owner. `saveSkillVisibility` and the permissions loader both
 * call this, so the UI can never mount an editable panel whose save then
 * fails. The generic extension actions' gate (canEditExtension +
 * skill kind hooks) mirrors the same set through the polymorphic tables,
 * which the dual-write hooks keep in sync with these legacy mirrors.
 */
export async function canManageSkillAccess(
  actorUserId: string | null,
  isAdmin: boolean,
  skill: {
    id: string;
    isCustomSkill?: boolean;
    ownerUserId?: string;
    packageId?: string;
  },
): Promise<boolean> {
  if (isAdmin) return true;
  if (!actorUserId) return false;
  const isUserAuthored = skill.isCustomSkill === true && typeof skill.ownerUserId === "string";
  if (isUserAuthored && skill.ownerUserId === actorUserId) return true;
  const skillCoOwners = await readSkillCoOwners(skill.id);
  if (skillCoOwners.some((c) => c.userId === actorUserId)) return true;
  if (isUserAuthored) return false; // pseudo-package never anchors manage
  if (!skill.packageId) return false;
  const installedBy = await readSkillPackageInstalledBy(skill.packageId);
  if (installedBy === actorUserId) return true;
  const packageCoOwners = await readSkillPackageCoOwners(skill.packageId);
  return packageCoOwners.some((c) => c.userId === actorUserId);
}

export async function loadSkillPermissionsContext(
  skillId: string,
): Promise<SkillPermissionsContext | null> {
  // Durable-identity dispatch (cinatra#1416): resolve the row first. A
  // user-authored skill anchors on its own ownership regardless of the
  // (level, scope) tuple OR the pseudo-package it is bucketed under.
  const catalog = await readSkillsCatalogSnapshot();
  const skillRow = catalog.skills.find((s) => s.id === skillId);
  if (!skillRow) return null;

  if (skillRow.isCustomSkill === true && typeof skillRow.ownerUserId === "string") {
    return loadPersonalSkillPermissionsContext(skillId, skillRow);
  }

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

// ---------------------------------------------------------------------------
// Personal-skill permissions context (cinatra#1416).
//
// Same context shape as the package path so the SAME ExtensionPermissionsClient
// mounts unchanged (the shared checkbox multi-scope picker, #1069). Authority
// derives from the ONE ownership model (`canManageSkillAccess`): durable owner
// + skill-level co-owners + platform admin. Strict read: canRead === canEdit —
// the access panel is management config; granted-scope READERS of the skill
// see the skill page but no panel (the AC5 mounting matrix).
// ---------------------------------------------------------------------------

async function loadPersonalSkillPermissionsContext(
  skillId: string,
  skillRow: {
    id: string;
    packageId?: string;
    isCustomSkill?: boolean;
    ownerUserId?: string;
  },
): Promise<SkillPermissionsContext> {
  const session = await requireAuthSession();
  const actorUserId = session.user?.id ?? null;
  const isAdmin = isPlatformAdmin(session);

  const canEdit = await canManageSkillAccess(actorUserId, isAdmin, skillRow);
  const canRead = canEdit;

  const base = {
    packageId: skillRow.packageId ?? "",
    skillId,
    isAdmin,
    currentUserId: actorUserId,
  };

  if (!canRead) {
    // Strict-read short-circuit: no policy / owner / co-owner views past the
    // gate — the caller MUST check canRead before mounting the panel.
    return {
      ...base,
      canRead: false,
      canEdit: false,
      initialPolicy: buildOwnerOnlyPolicy(),
      owner: null,
      coOwners: [],
      availableScopes: { orgs: [], projects: [], canGrantWorkspace: false },
    };
  }

  const owner = await resolveOwnerView(skillRow.ownerUserId ?? null);
  const skillCoOwnerRows = await readSkillCoOwners(skillId);
  const coOwners = await resolveUserViews(skillCoOwnerRows.map((r) => r.userId));
  const accessPolicy = await readSkillAccessPolicy(skillId);

  // Offered scopes = the manager's REAL memberships (readOrgsWithTeamsForUser /
  // readProjectsForUser) — the same assembly the package loader uses. The
  // server-side grantability re-validation on save is the enforcement
  // (#1069 predicate, diff-based); this list is the affordance.
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
    ...base,
    canRead,
    canEdit,
    // DEFAULT stays personal (owner-only) — broadening is always an explicit
    // manager action, never automatic.
    initialPolicy: accessPolicy ?? buildOwnerOnlyPolicy(),
    // The durable owner renders as the primary owner row (no removeOwner
    // action is wired for skills, so the row is display-only — ownership is
    // never destabilized by sharing).
    owner,
    coOwners,
    availableScopes: { orgs, projects, canGrantWorkspace },
  };
}

/** Resolve a list of user ids to OwnerViews via the shared BetterAuth lookup. */
async function resolveUserViews(
  userIds: string[],
): Promise<SkillPackagePermissionsOwnerView[]> {
  if (userIds.length === 0) return [];
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
  return userIds
    .map((id) => {
      const u = byId.get(id);
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
