"use server";

// ---------------------------------------------------------------------------
// Team member management server actions (cinatra#1567).
//
// Authorization contract (see `team-member-authority.ts` — the named interim
// predicate pending the #1566 team role-model decision):
//   - addTeamMemberAction(teamId, userId)      → canManageTeamMembers
//                                                 + target must be in the
//                                                   TEAM's org
//   - removeTeamMemberAction(teamId, userId)   → canManageTeamMembers
//                                                 + last-member guard
//   - searchTeamMemberCandidates(teamId, query)→ canManageTeamMembers
//
// Projected from the grant-form precedent
// (`src/app/projects/[projectId]/permissions/actions.ts`):
//   - candidates are NEVER derived from the viewer's own memberships — the
//     search is bounded by the TEAM's `organizationId`, resolved server-side;
//   - the authority gate fails closed WITHOUT an existence oracle: a missing
//     team and missing authority raise the identical `forbidden`;
//   - membership is roleless add/remove — `public."teamMember"` has NO role
//     column and this module must NOT add one (cinatra#1566 owns that).
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { betterAuthDb } from "@/lib/better-auth-db";
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
async function assertTeamMemberAuthority(teamId: string): Promise<{
  team: { id: string; organizationId: string };
}> {
  const forbidden = () =>
    new AuthzError({
      statusCode: 403,
      reason: "forbidden",
      message: "Org owner/admin (or platform admin) required.",
    });

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

  // Platform admin is an INDEPENDENT authority — checked before the org-role
  // resolution so an admin without a membership row in the team's org still
  // passes (the grant-candidate precedent).
  if (isPlatformAdmin(session)) return { team };

  const orgRole = await resolveOrgRoleForUser(team.organizationId, session.user.id);
  if (!canManageTeamMembers({ platformAdmin: false, orgRole })) {
    throw forbidden();
  }
  return { team };
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
        | "user_not_in_org"
        | "already_member"
        | "not_a_member"
        | "last_member"
        | "unknown_error";
    };

// ---------------------------------------------------------------------------
// addTeamMemberAction — roleless `public."teamMember"` insert.
// ---------------------------------------------------------------------------
export async function addTeamMemberAction(
  teamId: string,
  userId: string,
): Promise<TeamMemberActionResult> {
  try {
    const { team } = await assertTeamMemberAuthority(teamId);
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
// removeTeamMemberAction — roleless delete with a LAST-MEMBER guard.
//
// Conservative semantics (surfaced in the #1567 PR): a team never goes empty
// through this action. An empty team would stay visible only via the org
// admin widening and could still hold grants/skills with nobody on it, so
// removal of the final member is refused (`last_member`) — mirroring the
// last-platform-admin guard (`countOtherPlatformAdmins`). The per-team
// advisory lock makes two concurrent removals of the final two members (and
// remove-vs-add interleavings) serialize instead of racing to an empty team.
// ---------------------------------------------------------------------------
export async function removeTeamMemberAction(
  teamId: string,
  userId: string,
): Promise<TeamMemberActionResult> {
  try {
    const { team } = await assertTeamMemberAuthority(teamId);
    const targetUserId = userId.trim();
    if (!targetUserId) return { ok: false, error: "invalid_user" };

    const result = await betterAuthDb.transaction(async (tx) => {
      // Serialize on the per-team advisory lock: the membership read below
      // then runs on a fresh snapshot, so its count is authoritative for
      // this transaction.
      await tx.execute(takeTeamMembershipLock(team.id));
      const current = await tx.execute<{ userId: string }>(sql`
        SELECT "userId" FROM public."teamMember"
         WHERE "teamId" = ${team.id}
      `);
      const memberUserIds = (current.rows ?? []).map((r) => r.userId);
      if (!memberUserIds.includes(targetUserId)) {
        return { ok: false as const, error: "not_a_member" as const };
      }
      const others = memberUserIds.filter((id) => id !== targetUserId);
      if (others.length === 0) {
        return { ok: false as const, error: "last_member" as const };
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
