import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { AccessVsOwnershipNote } from "@/components/access-vs-ownership-note";
import { readProjectById } from "@/lib/projects-store";

import { CustomersClient, type CustomerGrant } from "./customers-client";
import { listCustomerGrants } from "./actions";

export const metadata: Metadata = { title: "Project customers" };

type Props = {
  params: Promise<{ projectId: string }>;
};

/**
 * Customer / external access management for a project (RBAC-EXT-01). Lists
 * customer grants and lets a project admin invite / revoke. Project-admin
 * gated inside listCustomerGrants → assertProjectAdmin.
 */
export default async function ProjectCustomersPage({ params }: Props) {
  const { projectId } = await params;
  const project = await readProjectById(projectId).catch(() => null);
  if (!project) notFound();

  let grants: CustomerGrant[] = [];
  try {
    const rows = await listCustomerGrants(projectId);
    grants = rows.map((r) => ({
      subjectUserId: r.subjectUserId,
      grantedAt: r.grantedAt.toISOString(),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    }));
  } catch {
    // Non-admin or store unavailable → render the empty surface (the
    // server actions re-check admin on every mutation).
    grants = [];
  }

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Customers"
        description="Invite external users to this project with scoped, read-mostly, revocable access."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <AccessVsOwnershipNote />
        <CustomersClient projectId={project.id} initialGrants={grants} />
      </PageContent>
    </Main>
  );
}
