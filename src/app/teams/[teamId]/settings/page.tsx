import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";

import {
  isPlatformAdmin,
  requireAuthSession,
  resolveOrgRoleForUser,
} from "@/lib/auth-session";
import { betterAuthDb, teamMemberRoleColumnExists } from "@/lib/better-auth-db";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { TeamSettingsForm } from "./team-settings-form";
import { TeamMembersSection, type TeamMemberView } from "./team-members-section";
import { canManageTeamMembers } from "./team-member-authority";

export const metadata: Metadata = { title: "Team settings" };

type TeamRow = {
  id: string;
  name: string;
  slug: string | null;
  organizationId: string;
  org_name: string;
  org_slug: string;
  is_member: boolean;
};

export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const session = await requireAuthSession();

  const rows = await betterAuthDb.execute<TeamRow>(sql`
    SELECT
      t.id,
      t.name,
      t.slug,
      t."organizationId",
      o.name AS org_name,
      o.slug AS org_slug,
      EXISTS (
        SELECT 1 FROM public."teamMember" tm
         WHERE tm."teamId" = t.id AND tm."userId" = ${session.user.id}
      ) AS is_member
    FROM public."team" t
    JOIN public."organization" o ON o.id = t."organizationId"
    WHERE t.id = ${teamId}
    LIMIT 1
  `);
  const team = rows.rows?.[0];
  if (!team) notFound();

  // Members list, with per-team roles (cinatra#1566) when the app-owned
  // `teamMember.role` column is provisioned on this deployment. On an
  // un-migrated deployment the query stays roleless and the page renders
  // exactly the pre-#1566 surface.
  const rolesEnabled = await teamMemberRoleColumnExists();
  const memberRows = await betterAuthDb.execute<{
    userId: string;
    name: string | null;
    email: string | null;
    role?: string | null;
  }>(
    rolesEnabled
      ? sql`
          SELECT tm."userId", u.name, u.email, tm.role
            FROM public."teamMember" tm
            JOIN public."user" u ON u.id = tm."userId"
           WHERE tm."teamId" = ${team.id}
           ORDER BY u.name, tm."userId"
        `
      : sql`
          SELECT tm."userId", u.name, u.email
            FROM public."teamMember" tm
            JOIN public."user" u ON u.id = tm."userId"
           WHERE tm."teamId" = ${team.id}
           ORDER BY u.name, tm."userId"
        `,
  );
  const members: TeamMemberView[] = (memberRows.rows ?? []).map((row) => ({
    userId: row.userId,
    name: row.name ?? row.email ?? "Unknown",
    email: row.email ?? "",
    role: rolesEnabled ? (row.role === "admin" ? "admin" : "member") : null,
  }));

  // Page gate (cinatra#1567 + #1566): team members keep their access; team
  // ADMINS of this team, org owners/admins of the TEAM's org, and platform
  // admins additionally manage membership — decided by the shared
  // `canManageTeamMembers` predicate. The viewer's own team role comes from
  // the member list just fetched (no extra query).
  const orgRole = await resolveOrgRoleForUser(team.organizationId, session.user.id);
  const viewerRole = members.find((m) => m.userId === session.user.id)?.role;
  const canManage = canManageTeamMembers({
    platformAdmin: isPlatformAdmin(session),
    orgRole,
    ...(viewerRole ? { teamRole: viewerRole } : {}),
  });
  if (!team.is_member && !canManage) redirect("/not-authorized");

  return (
    <Main className="min-h-screen">
      <PageHeader
        title={`Team settings — ${team.name}`}
        description={`Organization: ${team.org_name} (${team.org_slug})`}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Card>
          <CardHeader>
            <CardTitle>Team slug</CardTitle>
            <CardDescription>
              The team&apos;s URL-friendly identifier. Renaming the slug triggers an
              on-disk relocation of any team-scoped skills under
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
                data/skills/organization/{team.org_slug}/~teams/&lt;slug&gt;/
              </code>
              within ~1 second.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TeamSettingsForm teamId={team.id} currentSlug={team.slug ?? ""} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>
              {canManage
                ? rolesEnabled
                  ? "People on this team. Add members from this organization, remove them, or assign the Admin role — a team keeps at least one member."
                  : "People on this team. Add members from this organization or remove them — a team keeps at least one member."
                : "People on this team. Ask a team admin or an organization owner/admin to add or remove members."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TeamMembersSection
              teamId={team.id}
              members={members}
              canManage={canManage}
              rolesEnabled={rolesEnabled}
            />
          </CardContent>
        </Card>
      </PageContent>
    </Main>
  );
}
