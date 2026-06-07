"use server";

// ---------------------------------------------------------------------------
// Team slug rename server action.
//
// The DB trigger on public.team.slug UPDATE enqueues a path_relocations row
// that the relocation worker picks up to move data/skills/organization/<org>/
// ~teams/<old-slug>/ -> ~teams/<new-slug>/. This action is the user-facing
// surface to trigger that UPDATE.
//
// Auth gate: caller must be a member (any role) of the team (mirroring the
// pattern in /teams/new/actions.ts which checks org membership). Tighter
// admin-only gating can come later.
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireAuthSession } from "@/lib/auth-session";
import { betterAuthDb } from "@/lib/better-auth-db";

function isValidTeamSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && !slug.startsWith("~");
}

export async function renameTeamSlugAction(formData: FormData): Promise<{
  ok: true;
  teamId: string;
  oldSlug: string;
  newSlug: string;
} | {
  ok: false;
  error: "invalid-slug" | "not-found" | "forbidden" | "slug-conflict";
}> {
  const session = await requireAuthSession();
  const teamId = String(formData.get("teamId") ?? "").trim();
  const newSlug = String(formData.get("newSlug") ?? "").trim().toLowerCase();

  if (!teamId) return { ok: false, error: "not-found" };
  if (!newSlug || !isValidTeamSlug(newSlug)) return { ok: false, error: "invalid-slug" };

  // Look up the team + verify membership.
  const teamRows = await betterAuthDb.execute<{
    id: string;
    slug: string | null;
    organizationId: string;
  }>(sql`
    SELECT id, slug, "organizationId" FROM public."team" WHERE id = ${teamId} LIMIT 1
  `);
  const team = teamRows.rows?.[0];
  if (!team) return { ok: false, error: "not-found" };

  // Tighten auth. Two-stage gate:
  //   (1) caller must be a member of the team (public.teamMember)
  //   (2) caller must hold an admin/owner role on the team's parent organization
  //       (public.member.role IN ('admin','owner'))
  // Slug rename triggers a path-relocation of every team-scoped skill, so a
  // junior team member shouldn't be able to yank skills out from under the team.
  const memberRows = await betterAuthDb.execute<{ id: string }>(sql`
    SELECT id FROM public."teamMember"
     WHERE "teamId" = ${teamId} AND "userId" = ${session.user.id}
     LIMIT 1
  `);
  if (memberRows.rows.length === 0) return { ok: false, error: "forbidden" };
  const orgRoleRows = await betterAuthDb.execute<{ role: string | null }>(sql`
    SELECT m.role
      FROM public.member m
     WHERE m."userId" = ${session.user.id}
       AND m."organizationId" = ${team.organizationId}
     LIMIT 1
  `);
  const orgRole = orgRoleRows.rows?.[0]?.role ?? null;
  if (!(orgRole === "admin" || orgRole === "owner")) {
    return { ok: false, error: "forbidden" };
  }

  const oldSlug = team.slug ?? "";

  // Refuse rename for teams that don't yet have a slug. The DB trigger
  // enqueue_team_slug_move guards on OLD.slug IS NOT NULL AND OLD.slug <> ''
  // (src/lib/drizzle-store.ts) — so if we UPDATE from null/empty to a real
  // slug, the trigger fires but short-circuits, and no path_relocations row
  // is enqueued. The on-disk move never happens. Block here so the user gets
  // an actionable error instead of a silently broken rename. Any team that
  // still has null/empty needs an explicit operator action.
  if (!oldSlug) {
    return { ok: false, error: "not-found" };
  }
  if (oldSlug === newSlug) {
    return { ok: true, teamId, oldSlug, newSlug };
  }

  try {
    // The trigger on public.team fires regardless of UPDATE source (raw SQL
    // or better-auth client) — we use raw SQL here for determinism so the
    // production code path doesn't depend on whether better-auth's
    // additionalFields persistence happens to be wired correctly.
    await betterAuthDb.execute(sql`
      UPDATE public."team"
         SET slug = ${newSlug}, "updatedAt" = NOW()
       WHERE id = ${teamId}
    `);
  } catch (err) {
    // CHECK violations are pg code 23514, UNIQUE are 23505. The original
    // `||` pattern alternation could never match team_slug_format (a CHECK).
    // Handle both codes; map format-CHECK to "invalid-slug" so the UI shows
    // the right message rather than the generic uniqueness error.
    const pgErr = err as { code?: string; constraint?: string; message?: string };
    const constraint = String(pgErr.constraint ?? pgErr.message ?? "");
    if (pgErr?.code === "23505" && /team_slug_uniq_in_org/.test(constraint)) {
      return { ok: false, error: "slug-conflict" };
    }
    if (pgErr?.code === "23514" && /team_slug_format/.test(constraint)) {
      return { ok: false, error: "invalid-slug" };
    }
    throw err;
  }

  revalidatePath(`/teams/${teamId}/settings`);
  revalidatePath(`/teams`);
  return { ok: true, teamId, oldSlug, newSlug };
}
