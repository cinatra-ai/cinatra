import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { requireAdminSession } from "@/lib/auth-session";
import { WebhooksTable } from "@/app/webhooks/_components/webhooks-table";

export const metadata: Metadata = { title: "Webhooks" };

export default async function WebhooksPage() {
  // Host-admin surface — re-enforce admin at the page (the nav hide is
  // cosmetic). Mirrors src/app/configuration/page.tsx.
  await requireAdminSession();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Webhooks"
        description="Inbound webhooks declared by extensions, served by the generic webhook facility."
      />
      <PageContent className="pb-8">
        <WebhooksTable />
      </PageContent>
    </Main>
  );
}
