import type { Metadata } from "next";
import { sql } from "drizzle-orm";

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { betterAuthDb } from "@/lib/better-auth-db";
import { canManageTeamMembers } from "./settings/team-member-authority";

// Gate-repeating metadata (cinatra#1737, the dashboards pattern): the tab
// title repeats the screen's own gates (tenant alignment + member-or-manager)
// before disclosing the team name; any failure yields the generic title.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ teamId: string }>;
}): Promise<Metadata> {
  try {
    const { teamId } = await params;
    const session = await requireAuthSession();
    const rows = await betterAuthDb.execute<{
      name: string;
      organizationId: string;
      is_member: boolean;
    }>(sql`
      SELECT
        t.name,
        t."organizationId",
        EXISTS (
          SELECT 1 FROM public."teamMember" tm
           WHERE tm."teamId" = t.id AND tm."userId" = ${session.user.id}
        ) AS is_member
      FROM public."team" t
      WHERE t.id = ${teamId}
      LIMIT 1
    `);
    const team = rows.rows?.[0];
    if (!team) return { title: "Team" };
    // Tenant-alignment gate (mirrors the screen).
    const activeOrgId = session.session?.activeOrganizationId ?? null;
    if (activeOrgId !== team.organizationId) return { title: "Team" };
    // Member-or-manager (a non-member has no team role — the light form is
    // authorization-equivalent to the screen's predicate).
    const orgRole = await resolveOrgRoleForUser(team.organizationId, session.user.id);
    const canManage = canManageTeamMembers({
      platformAdmin: isPlatformAdmin(session),
      orgRole,
    });
    if (!team.is_member && !canManage) return { title: "Team" };
    return { title: team.name };
  } catch {
    return { title: "Team" };
  }
}

// /teams/[teamId] renders the per-team dashboards surface (read-only Overview
// + custom dashboards). The /teams linked table points rows here. Team
// MANAGEMENT (members, roles, rename) lives on the sibling
// `/teams/[teamId]/settings` — the single management surface (cinatra#1688).
export { TeamDetailDashboardPage as default } from "@cinatra-ai/dashboards/screens";
