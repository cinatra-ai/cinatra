import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuthSession } from "@/lib/auth-session";
import { readTeamCreatableOrganizationsForUser } from "@/lib/better-auth-db";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { NewTeamForm } from "./new-team-form";

export const metadata: Metadata = { title: "Create Team" };

type NewTeamPageProps = {
  searchParams?: Promise<{ error?: string }>;
};

export default async function NewTeamPage({ searchParams }: NewTeamPageProps) {
  const session = await requireAuthSession();
  const organizations = await readTeamCreatableOrganizationsForUser(
    session.user.id,
    session.user.role,
  );

  if (organizations.length === 0) {
    redirect("/not-authorized");
  }

  const params = await searchParams;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Create team"
        description="Create a capability and governance space inside an organization you administer."
      />
      <PageContent className="pb-8">
        <NewTeamForm organizations={organizations} initialError={params?.error} />
      </PageContent>
    </Main>
  );
}
