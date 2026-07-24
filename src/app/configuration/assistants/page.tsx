import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/auth-session";
import { readAssistantAdminRegistry } from "@/lib/assistant-admin-registry";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { AssistantsTable } from "./assistants-table";

export const metadata: Metadata = { title: "Assistants" };

export default async function SettingsAssistantsPage() {
  // Platform-admin gated (AC#4).
  await requireAdminSession();
  const rows = await readAssistantAdminRegistry();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Assistants"
        description="Manage AI assistant identities and their MCP OAuth clients. Assistants can be @mentioned in chat threads."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <section className="soft-panel rounded-card px-6 py-6">
          <AssistantsTable rows={rows} />
        </section>
      </PageContent>
    </Main>
  );
}
