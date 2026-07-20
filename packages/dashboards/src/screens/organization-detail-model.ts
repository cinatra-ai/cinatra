/**
 * Pure model helpers for the `/organizations/[id]` detail surface (cinatra#705).
 *
 * These carry NO database, React, or `server-only` imports so the entity-ref
 * shape and the access-model shaping are unit-testable in isolation; the screen
 * (`organization-detail-dashboard.tsx`) does the access-gated Better-Auth reads
 * and hands the raw rows here to be normalized.
 *
 * The org detail Dashboards tab is a PER-INSTANCE, PER-USER entity dashboard set
 * (epic #699 / #700): `entityType: "organization"` (the per-instance type, not
 * the migratable `organizations` index surface), `entityId` is the specific org
 * id, and the owner axis is the viewing user — so each member keeps their own
 * dashboards for the org while sharing the non-removable Overview identity.
 */
import type { DashboardEntityRef } from "../store/entity-identity";

/**
 * The (entity, owner) ref for a user's dashboards on ONE organization's detail
 * page. `ownerLevel: "user"` / `ownerId: userId` scopes the set to the viewer;
 * the org (tenant) is supplied by the actor's active org at the service layer,
 * never from this ref (see `entity-identity.ts`).
 */
export function buildOrganizationDetailRef(
  orgId: string,
  userId: string,
): DashboardEntityRef {
  return {
    entityType: "organization",
    entityId: orgId,
    ownerLevel: "user",
    ownerId: userId,
  };
}

/** A raw Better-Auth `member`-plus-`user` row the screen fetched for the org. */
export type OrganizationMemberInput = {
  readonly userId: string;
  readonly name: string | null;
  readonly email: string | null;
  readonly role: string | null;
  /**
   * The Better-Auth `member` row id — required by `updateMemberRole` /
   * `removeMember` (both take `memberId` / `memberIdOrEmail`, NOT the user id).
   * Optional here because the read-only access-model view (`buildOrganizationAccessModel`)
   * never needs it; the management view (`buildOrganizationManageMembers`) does.
   */
  readonly id?: string | null;
};

/** A raw team row (id + name) in the org. */
export type OrganizationTeamInput = {
  readonly id: string;
  readonly name: string;
};

/** One normalized member row in the Permissions access-model view. */
export type OrganizationAccessMember = {
  readonly userId: string;
  readonly displayName: string;
  /** Normalized org role — never blank (bare membership ⇒ "member"). */
  readonly role: OrganizationRole;
};

export type OrganizationRole = "owner" | "admin" | "member";

/** The org's access model as rendered by the Permissions tab (read-only). */
export type OrganizationAccessModel = {
  readonly members: readonly OrganizationAccessMember[];
  readonly teams: readonly OrganizationTeamInput[];
  readonly memberCount: number;
  readonly teamCount: number;
};

/** Better-Auth stores org roles as a comma-separated string ("owner",
 *  "admin", "member", or bare membership as null/""). Collapse to the single
 *  highest-privilege role for display; unknown/blank ⇒ "member". */
export function normalizeOrganizationRole(raw: string | null | undefined): OrganizationRole {
  const roles = String(raw ?? "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

const ROLE_RANK: Readonly<Record<OrganizationRole, number>> = {
  owner: 0,
  admin: 1,
  member: 2,
};

/** Best-effort human label for a member: name, else email, else the raw id. */
export function memberDisplayName(member: OrganizationMemberInput): string {
  const name = member.name?.trim();
  if (name) return name;
  const email = member.email?.trim();
  if (email) return email;
  return member.userId;
}

/**
 * Normalize + order the raw member/team rows into the Permissions access model.
 * Members sort by role privilege (owner → admin → member) then display name
 * (case-insensitive); teams are passed through in the order the caller supplied
 * (the store already returns them name-ordered). Counts are the TOTALs — the
 * same numbers the Overview count portlet renders — so the two tabs never
 * disagree.
 */
export function buildOrganizationAccessModel(
  members: readonly OrganizationMemberInput[],
  teams: readonly OrganizationTeamInput[],
): OrganizationAccessModel {
  const normalized: OrganizationAccessMember[] = members.map((m) => ({
    userId: m.userId,
    displayName: memberDisplayName(m),
    role: normalizeOrganizationRole(m.role),
  }));
  normalized.sort((a, b) => {
    const byRole = ROLE_RANK[a.role] - ROLE_RANK[b.role];
    if (byRole !== 0) return byRole;
    return a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: "accent",
    });
  });
  return {
    members: normalized,
    teams,
    memberCount: members.length,
    teamCount: teams.length,
  };
}

// ---------------------------------------------------------------------------
// Management view (cinatra#1510) — the org_owner "Members" management console.
// Distinct from the read-only access model above: it carries the Better-Auth
// `member.id` (the write handle) and is scoped to actionable rows.
// ---------------------------------------------------------------------------

/** One member row for the management console (role change / remove). */
export type OrganizationManageMember = {
  /** Better-Auth `member` row id — the `updateMemberRole`/`removeMember` handle. */
  readonly memberId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly role: OrganizationRole;
};

/**
 * Shape the raw member rows into the management console list: same
 * normalize + sort as the access model, but keyed by the `member.id` write
 * handle and dropping any row without one (a row we could not act on). Rows
 * missing an `id` are excluded rather than rendered as dead controls.
 */
export function buildOrganizationManageMembers(
  members: readonly OrganizationMemberInput[],
): readonly OrganizationManageMember[] {
  const rows: OrganizationManageMember[] = [];
  for (const m of members) {
    const memberId = m.id?.trim();
    if (!memberId) continue;
    rows.push({
      memberId,
      userId: m.userId,
      displayName: memberDisplayName(m),
      role: normalizeOrganizationRole(m.role),
    });
  }
  rows.sort((a, b) => {
    const byRole = ROLE_RANK[a.role] - ROLE_RANK[b.role];
    if (byRole !== 0) return byRole;
    return a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: "accent",
    });
  });
  return rows;
}

/** A pending organization invitation row (management console). */
export type OrganizationPendingInvitation = {
  readonly id: string;
  readonly email: string;
  readonly role: OrganizationRole;
};

/** Normalize a raw invitation row (Better-Auth stores `role` as owner/admin/member). */
export function normalizePendingInvitation(input: {
  readonly id: string;
  readonly email: string | null;
  readonly role: string | null;
}): OrganizationPendingInvitation {
  return {
    id: input.id,
    email: input.email?.trim() || input.id,
    role: normalizeOrganizationRole(input.role),
  };
}
