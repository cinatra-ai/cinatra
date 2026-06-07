import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { sql } from "drizzle-orm";

import { requireAuthSession } from "@/lib/auth-session";
import { betterAuthDb } from "@/lib/better-auth-db";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { TeamSettingsForm } from "./team-settings-form";

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
  if (!team.is_member) redirect("/not-authorized");

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
      </PageContent>
    </Main>
  );
}
