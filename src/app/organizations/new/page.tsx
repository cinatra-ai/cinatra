import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireAuthSession } from "@/lib/auth-session";
import { userCanCreateOrganizations } from "@/lib/authz/organization-create-gate";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { NewOrganizationForm } from "./new-organization-form";

export const metadata: Metadata = { title: "Create Organization" };

type NewOrganizationPageProps = {
  searchParams?: Promise<{ error?: string }>;
};

export default async function NewOrganizationPage({
  searchParams,
}: NewOrganizationPageProps) {
  const session = await requireAuthSession();

  // Same gate as the /organizations page action and the global `+` menu:
  // single-org mode off AND `organization.create` held. The create endpoint
  // re-enforces this server-side regardless.
  if (!(await userCanCreateOrganizations(session))) {
    redirect("/not-authorized");
  }

  const params = await searchParams;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Create organization"
        description="Create a new organization workspace. You become its first member and it becomes your active organization."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <NewOrganizationForm initialError={params?.error} />
      </PageContent>
    </Main>
  );
}
