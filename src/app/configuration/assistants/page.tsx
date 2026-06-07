import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminSession } from "@/lib/auth-session";
import { listAssistantUsers } from "@/lib/assistant-users";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { AssistantsTable } from "./assistants-table";

export const metadata: Metadata = { title: "Assistants" };

export default async function SettingsAssistantsPage() {
  await requireAdminSession();
  const assistants = await listAssistantUsers();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Assistants"
        description="Manage AI assistant identities and their MCP OAuth clients. Assistants can be @mentioned in chat threads."
        actions={
          <div className="flex gap-2">
            <Link
              href="/connectors/cinatra-ai/drupal-assistant-connector/setup"
              className="inline-flex items-center justify-center rounded-control border border-line bg-surface-strong px-5 py-3 text-sm font-semibold text-foreground transition hover:border-primary"
            >
              Drupal Widget
            </Link>
            <Link
              href="/connectors/cinatra-ai/wordpress-assistant-connector/setup"
              className="inline-flex items-center justify-center rounded-control border border-line bg-surface-strong px-5 py-3 text-sm font-semibold text-foreground transition hover:border-primary"
            >
              WordPress Widget
            </Link>
          </div>
        }
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <section className="soft-panel rounded-card px-6 py-6">
          <AssistantsTable assistants={assistants} />
        </section>
      </PageContent>
    </Main>
  );
}
