"use server";

// ---------------------------------------------------------------------------
// Team member management server actions (cinatra#1567 + the #1566 role model).
//
// Authorization contract (see `team-member-authority.ts` — team admin of the
// team, org owner/admin of the team's org, or platform admin):
//   - addTeamMemberAction(teamId, userId)      → canManageTeamMembers
//                                                 + target must be in the
//                                                   TEAM's org
//   - removeTeamMemberAction(teamId, userId)   → canManageTeamMembers
//                                                 + last-member guard
//                                                 + last-admin guard (#1686)
//   - updateTeamMemberRoleAction(teamId, userId, role)
//                                              → canManageTeamMembers
//                                                 + role column provisioned
//                                                 + last-admin guard on
//                                                   demotion (#1686)
//   - searchTeamMemberCandidates(teamId, query)→ canManageTeamMembers
//
// Projected from the grant-form precedent
// (`src/app/projects/[projectId]/permissions/actions.ts`):
//   - candidates are NEVER derived from the viewer's own memberships — the
//     search is bounded by the TEAM's `organizationId`, resolved server-side;
//   - the authority gate fails closed WITHOUT an existence oracle: a missing
//     team and missing authority raise the identical `forbidden`;
//   - the membership INSERT stays roleless BY DESIGN — new members get
//     'member' via the app-owned column's DEFAULT (cinatra#1566), and the
//     statement keeps working on deployments where the column is not
//     provisioned yet.
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import {
  betterAuthDb,
  teamMemberRoleColumnExists,
  teamMemberRoleColumnExistsStrict,
} from "@/lib/better-auth-db";
import { AuthzError } from "@/lib/authz/errors";

import { canManageTeamMembers } from "./team-member-authority";

/**
 * Authority gate for every member-management action: resolve the team, then
 * apply `canManageTeamMembers` against the TEAM's organization (never the
 * viewer's active org). Fails closed without an existence oracle — a missing
 * team and missing authority raise the identical AuthzError("forbidden"), so
 * probing team ids reveals nothing (the `assertProjectGrantAuthority`
 * precedent).
 */
const forbidden = () =>
  new AuthzError({
    statusCode: 403,
    reason: "forbidden",
    message: "Team admin, org owner/admin, or platform admin required.",
  });

/**
 * Which tier admitted the caller. `team_admin` is special: it is derived
 * from the very `teamMember` rows the mutations change, so it MUST be
 * re-verified inside the advisory-locked transaction before mutating (see
 * `assertTeamAdminAuthorityOnTx`). Platform/org tiers live outside this
 * table and need no in-lock re-check.
 */
type TeamAuthorityTier = "platform" | "org" | "team_admin";

async function assertTeamMemberAuthority(teamId: string): Promise<{
  team: { id: string; organizationId: string };
  authorityTier: TeamAuthorityTier;
  callerUserId: string;
}> {
  // `requireAuthSession` throws Next's redirect sentinel when there is no
  // session; the actions' generic try/catch must never swallow it into an
  // `{ok:false}` payload. Coerce a missing session to null and fail closed
  // as the same typed AuthzError as every other authority failure.
  const session = await requireAuthSession().catch(() => null);
  if (!session) throw forbidden();

  const teamRows = teamId
    ? await betterAuthDb.execute<{ id: string; organizationId: string }>(sql`
        SELECT id, "organizationId" FROM public."team" WHERE id = ${teamId} LIMIT 1
      `)
    : null;
  const team = teamRows?.rows?.[0];
  if (!team) throw forbidden();

  const callerUserId = session.user.id;

  // Platform admin is an INDEPENDENT authority — checked before the org-role
  // resolution so an admin without a membership row in the team's org still
  // passes (the grant-candidate precedent).
  if (isPlatformAdmin(session)) {
    return { team, authorityTier: "platform", callerUserId };
  }

  const orgRole = await resolveOrgRoleForUser(team.organizationId, callerUserId);
  if (canManageTeamMembers({ platformAdmin: false, orgRole })) {
    return { team, authorityTier: "org", callerUserId };
  }

  // Team-admin tier (cinatra#1566), resolved LAZILY: only after the org tiers
  // failed, and only when the app-owned role column is provisioned — so the
  // common paths cost nothing extra and un-migrated deployments behave
  // exactly as before the role model landed.
  const teamRole = await resolveCallerTeamRole(team.id, callerUserId);
  if (!canManageTeamMembers({ platformAdmin: false, orgRole, teamRole })) {
    throw forbidden();
  }
  return { team, authorityTier: "team_admin", callerUserId };
}

/** The caller's own role in the team (DB vocabulary), or `undefined` when
 *  they are not a member / the role column is not provisioned. */
async function resolveCallerTeamRole(
  teamId: string,
  userId: string,
): Promise<"admin" | "member" | undefined> {
  if (!(await teamMemberRoleColumnExists())) return undefined;
  const rows = await betterAuthDb.execute<{ role: string | null }>(sql`
    SELECT role FROM public."teamMember"
     WHERE "teamId" = ${teamId} AND "userId" = ${userId}
     LIMIT 1
  `);
  const row = rows.rows?.[0];
  if (!row) return undefined;
  return row.role === "admin" ? "admin" : "member";
}

/**
 * In-lock authority re-check for team-admin callers. The gate's team-role
 * read runs BEFORE the transaction, so a caller demoted/removed between the
 * gate and the lock grant would otherwise mutate with STALE authority (their
 * queued request wins the lock after the demotion committed). The advisory
 * lock serializes every membership mutation for the team, so a re-read on
 * the transaction's own snapshot is authoritative. Throws the SAME
 * `forbidden` as the gate.
 */
async function assertTeamAdminAuthorityOnTx(
  tx: { execute: typeof betterAuthDb.execute },
  teamId: string,
  callerUserId: string,
): Promise<void> {
  const rows = await tx.execute<{ role: string | null }>(sql`
    SELECT role FROM public."teamMember"
     WHERE "teamId" = ${teamId} AND "userId" = ${callerUserId}
     LIMIT 1
  `);
  if (rows.rows?.[0]?.role !== "admin") throw forbidden();
}

/**
 * Serialize ALL membership mutations for one team on a transaction-scoped
 * advisory lock (the `pg_advisory_xact_lock` precedent of auth.ts /
 * skill-lifecycle-store). `public."teamMember"` has no (teamId, userId)
 * unique constraint (Better Auth owns that schema), so statement-level
 * guards alone race under READ COMMITTED — the lock makes add's duplicate
 * check and remove's last-member count authoritative: a competing mutation
 * for the SAME team commits either before the lock is granted (the fresh
 * per-statement snapshot then sees it) or after this transaction releases it.
 */
function takeTeamMembershipLock(teamId: string) {
  return sql`SELECT pg_advisory_xact_lock(hashtext('cinatra-team-members'), hashtext(${teamId}))`;
}

export type TeamMemberActionResult =
  | { ok: true }
  | {
      ok: false;
      error:
        | "forbidden"
        | "invalid_user"
        | "invalid_role"
        | "user_not_in_org"
        | "already_member"
        | "not_a_member"
        | "last_member"
        | "last_admin"
        | "role_unavailable"
        | "unknown_error";
    };

// ---------------------------------------------------------------------------
// addTeamMemberAction — `public."teamMember"` insert. Deliberately does NOT
// name the role column: new members join as 'member' via the app-owned
// column's DEFAULT (cinatra#1566), and the statement keeps working on
// deployments where the column is not provisioned yet.
// ---------------------------------------------------------------------------
export async function addTeamMemberAction(
  teamId: string,
  userId: string,
): Promise<TeamMemberActionResult> {
  try {
    const { team, authorityTier, callerUserId } =
      await assertTeamMemberAuthority(teamId);
    const targetUserId = userId.trim();
    if (!targetUserId) return { ok: false, error: "invalid_user" };

    // Org boundary: the candidate must already be a member of the TEAM's
    // organization. Without this, a manager could put any Better Auth user
    // id on a team across tenant boundaries (the addProjectCoOwnerAction
    // guard, but bound to the team's org — teams always carry one).
    const orgMembership = await betterAuthDb.execute<{ id: string }>(sql`
      SELECT id FROM public.member
       WHERE "userId" = ${targetUserId}
         AND "organizationId" = ${team.organizationId}
       LIMIT 1
    `);
    if ((orgMembership.rows?.length ?? 0) === 0) {
      return { ok: false, error: "user_not_in_org" };
    }

    // Duplicate-safe insert: `public."teamMember"` has no (teamId, userId)
    // unique constraint, so serialize on the per-team advisory lock and
    // guard in the statement — after the lock is granted, the NOT EXISTS
    // runs on a fresh snapshot that sees any competing add that got there
    // first (codex 1567-r1: WHERE NOT EXISTS alone raced).
    const result = await betterAuthDb.transaction(async (tx) => {
      await tx.execute(takeTeamMembershipLock(team.id));
      // Team-admin authority is derived from the rows this lock serializes —
      // re-verify it on the locked snapshot (a concurrently demoted/removed
      // admin's queued request must NOT mutate with stale authority).
      if (authorityTier === "team_admin") {
        await assertTeamAdminAuthorityOnTx(tx, team.id, callerUserId);
      }
      const inserted = await tx.execute<{ id: string }>(sql`
        INSERT INTO public."teamMember" (id, "teamId", "userId", "createdAt")
        SELECT ${randomUUID()}, ${team.id}, ${targetUserId}, ${new Date()}
        WHERE NOT EXISTS (
          SELECT 1 FROM public."teamMember"
           WHERE "teamId" = ${team.id} AND "userId" = ${targetUserId}
        )
        RETURNING id
      `);
      return (inserted.rows?.length ?? 0) > 0
        ? { ok: true as const }
        : { ok: false as const, error: "already_member" as const };
    });
    if (!result.ok) return result;

    revalidatePath(`/teams/${team.id}/settings`);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: "forbidden" };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// removeTeamMemberAction — delete with LAST-MEMBER and LAST-ADMIN guards.
//
// Conservative semantics (surfaced in the #1567 PR): a team never goes empty
// through this action. An empty team would stay visible only via the org
// admin widening and could still hold grants/skills with nobody on it, so
// removal of the final member is refused (`last_member`) — mirroring the
// last-platform-admin guard (`countOtherPlatformAdmins`). The per-team
// advisory lock makes two concurrent removals of the final two members (and
// remove-vs-add interleavings) serialize instead of racing to an empty team.
//
// LAST-ADMIN guard (cinatra#1686): with the role model provisioned, removing
// the only `admin` while other members remain is refused (`last_admin`) —
// otherwise a team-admin-only actor orphans the team for everyone on it
// (Better Auth's own org semantics likewise protect the last owner). Applies
// to EVERY authority tier, like `last_member`: org/platform rescuers can
// promote a replacement first, and the team never silently drops to zero
// admins. On roleless deployments the guard is inert (no admin concept).
// ---------------------------------------------------------------------------
export async function removeTeamMemberAction(
  teamId: string,
  userId: string,
): Promise<TeamMemberActionResult> {
  try {
    const { team, authorityTier, callerUserId } =
      await assertTeamMemberAuthority(teamId);
    const targetUserId = userId.trim();
    if (!targetUserId) return { ok: false, error: "invalid_user" };
    // STRICT probe (CodeRabbit 1689-r1): the fail-soft variant treats a
    // transient probe failure as "roleless", which would silently skip the
    // last-admin guard while the DELETE still succeeds. A guard must fail
    // CLOSED — on probe failure the removal aborts (retryable) instead of
    // proceeding unguarded. Genuine absence still degrades to the roleless
    // statement, so un-provisioned deployments behave exactly as before.
    let rolesProvisioned: boolean;
    try {
      rolesProvisioned = await teamMemberRoleColumnExistsStrict();
    } catch {
      return { ok: false, error: "unknown_error" };
    }

    const result = await betterAuthDb.transaction(async (tx) => {
      // Serialize on the per-team advisory lock: the membership read below
      // then runs on a fresh snapshot, so its count is authoritative for
      // this transaction.
      await tx.execute(takeTeamMembershipLock(team.id));
      // Stale-authority guard (see addTeamMemberAction).
      if (authorityTier === "team_admin") {
        await assertTeamAdminAuthorityOnTx(tx, team.id, callerUserId);
      }
      const current = await tx.execute<{ userId: string; role?: string | null }>(
        rolesProvisioned
          ? sql`
              SELECT "userId", role FROM public."teamMember"
               WHERE "teamId" = ${team.id}
            `
          : sql`
              SELECT "userId" FROM public."teamMember"
               WHERE "teamId" = ${team.id}
            `,
      );
      const rows = current.rows ?? [];
      const memberUserIds = rows.map((r) => r.userId);
      if (!memberUserIds.includes(targetUserId)) {
        return { ok: false as const, error: "not_a_member" as const };
      }
      const others = memberUserIds.filter((id) => id !== targetUserId);
      if (others.length === 0) {
        return { ok: false as const, error: "last_member" as const };
      }
      // Last-admin guard (#1686) — after last_member, which is the more
      // fundamental refusal when the sole member is also the sole admin.
      if (rolesProvisioned) {
        const targetIsAdmin = rows.some(
          (r) => r.userId === targetUserId && r.role === "admin",
        );
        const otherAdmins = rows.filter(
          (r) => r.userId !== targetUserId && r.role === "admin",
        );
        if (targetIsAdmin && otherAdmins.length === 0) {
          return { ok: false as const, error: "last_admin" as const };
        }
      }
      await tx.execute(sql`
        DELETE FROM public."teamMember"
         WHERE "teamId" = ${team.id} AND "userId" = ${targetUserId}
      `);
      return { ok: true as const };
    });

    if (result.ok) {
      revalidatePath(`/teams/${team.id}/settings`);
    }
    return result;
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: "forbidden" };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// updateTeamMemberRoleAction — per-team role assignment (cinatra#1566).
//
// Same authority gate as add/remove; the mutation serializes on the SAME
// per-team advisory lock so a role change cannot interleave with a concurrent
// add/remove of the same membership row.
//
// LAST-ADMIN guard on demotion (cinatra#1686, superseding the earlier
// no-guard stance): demoting the only `admin` is refused (`last_admin`).
// A team-admin-only actor who self-demotes would otherwise orphan the team
// for everyone on it; requiring a replacement admin FIRST keeps the team
// managed at every moment. Uniform across authority tiers, like the
// last-member guard — org owner/admin and platform admin promote someone
// else first (one extra click), and in exchange no team ever silently
// drops to zero admins. Evaluated inside the advisory-locked transaction so
// the admin count is authoritative under READ COMMITTED.
// ---------------------------------------------------------------------------
export async function updateTeamMemberRoleAction(
  teamId: string,
  userId: string,
  role: "member" | "admin",
): Promise<TeamMemberActionResult> {
  try {
    const { team, authorityTier, callerUserId } =
      await assertTeamMemberAuthority(teamId);
    const targetUserId = userId.trim();
    if (!targetUserId) return { ok: false, error: "invalid_user" };
    // Runtime allowlist — the parameter type does not survive the client
    // boundary of a server action.
    if (role !== "member" && role !== "admin") {
      return { ok: false, error: "invalid_role" };
    }
    if (!(await teamMemberRoleColumnExists())) {
      return { ok: false, error: "role_unavailable" };
    }

    const result = await betterAuthDb.transaction(async (tx) => {
      await tx.execute(takeTeamMembershipLock(team.id));
      // Stale-authority guard (see addTeamMemberAction).
      if (authorityTier === "team_admin") {
        await assertTeamAdminAuthorityOnTx(tx, team.id, callerUserId);
      }
      // Last-admin guard (#1686): a demotion may not remove the team's only
      // admin. The read runs on the locked snapshot, so it cannot race a
      // concurrent promote/demote/remove of the same team. Evaluated per
      // DISTINCT user, not per row — `teamMember` has no (teamId, userId)
      // unique constraint, so duplicate rows for the target must not count
      // as a "second admin" (the UPDATE below would demote them all at once;
      // codex 1686-r1).
      if (role === "member") {
        const admins = await tx.execute<{ userId: string }>(sql`
          SELECT "userId" FROM public."teamMember"
           WHERE "teamId" = ${team.id} AND role = 'admin'
        `);
        const adminRows = admins.rows ?? [];
        const targetIsAdmin = adminRows.some((r) => r.userId === targetUserId);
        const hasOtherAdmin = adminRows.some((r) => r.userId !== targetUserId);
        if (targetIsAdmin && !hasOtherAdmin) {
          return { ok: false as const, error: "last_admin" as const };
        }
      }
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE public."teamMember"
           SET role = ${role}
         WHERE "teamId" = ${team.id} AND "userId" = ${targetUserId}
         RETURNING id
      `);
      return (updated.rows?.length ?? 0) > 0
        ? { ok: true as const }
        : { ok: false as const, error: "not_a_member" as const };
    });
    if (!result.ok) return result;

    revalidatePath(`/teams/${team.id}/settings`);
    return { ok: true };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: "forbidden" };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// searchTeamMemberCandidates — typeahead for the add-member combobox.
// ---------------------------------------------------------------------------
export type TeamMemberCandidate = {
  id: string;
  name: string;
  email: string;
  image: string | null;
};

/**
 * User candidates for adding a team member: members of the TEAM's
 * organization, name/email substring-matched. Gated on the SAME authority as
 * the mutations (the picker is an affordance only — final authority stays in
 * `addTeamMemberAction`). Existing team members are excluded client-side via
 * the combobox's `excludeIds` (the grant-form exclude-or-mark rule); the
 * server re-guards with `already_member` on add.
 */
export async function searchTeamMemberCandidates(
  teamId: string,
  query: string,
): Promise<
  { ok: true; results: TeamMemberCandidate[] } | { ok: false; error: string }
> {
  try {
    const { team } = await assertTeamMemberAuthority(teamId);

    // Escape the LIKE/ILIKE escape character (backslash) FIRST, then the
    // `%`/`_` wildcards, all via the single character class `[\\%_]` — the
    // `toIlikePattern` / `searchWorkspaceUsersForProject` escaping.
    const trimmed = query.trim();
    const like = trimmed.length > 0 ? `%${trimmed.replace(/[\\%_]/g, "\\$&")}%` : null;

    const rows = await betterAuthDb.execute<{
      id: string;
      name: string | null;
      email: string | null;
      image: string | null;
    }>(sql`
      SELECT u.id, u.name, u.email, u.image
        FROM public."user" u
        JOIN public.member m
          ON m."userId" = u.id
         AND m."organizationId" = ${team.organizationId}
       WHERE ${like === null ? sql`TRUE` : sql`(u.name ILIKE ${like} OR u.email ILIKE ${like})`}
       ORDER BY u.name, u.id
       LIMIT 20
    `);

    return {
      ok: true,
      results: (rows.rows ?? []).map((r) => ({
        id: r.id,
        name: r.name ?? r.email ?? "Unknown",
        email: r.email ?? "",
        image: r.image ?? null,
      })),
    };
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.reason };
    return {
      ok: false,
      error: err instanceof Error ? err.message : "unknown_error",
    };
  }
}
