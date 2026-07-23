import type { Metadata } from "next";
import Link from "next/link";
import { requireAdminSession } from "@/lib/auth-session";
import { readAssistantAdminRegistry } from "@/lib/assistant-admin-registry";
import { readOrgsWithTeamsForUser, readProjectsForUser } from "@/lib/better-auth-db";
import type { AvailableScopes } from "@/components/access-combobox";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { AssistantsTable } from "./assistants-table";

export const metadata: Metadata = { title: "Assistants" };

export default async function SettingsAssistantsPage() {
  // Platform-admin gated (AC#4).
  const session = await requireAdminSession();
  const rows = await readAssistantAdminRegistry();

  // The access-picker catalog for the audience editor — the admin's orgs (with
  // their teams) + active-org projects, exactly as the extension access-control
  // and permissions surfaces build it. A platform admin can grant the whole
  // workspace, so `canGrantWorkspace` is true here.
  const userId = session.user.id;
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  const [orgs, projects] = await Promise.all([
    readOrgsWithTeamsForUser(userId),
    activeOrgId ? readProjectsForUser(userId, activeOrgId) : Promise.resolve([]),
  ]);
  const availableScopes: AvailableScopes = {
    orgs: orgs.map((org) => ({
      id: org.id,
      name: org.name,
      teams: org.teams.map((t) => ({ id: t.id, name: t.name })),
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    canGrantWorkspace: true,
  };

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
          <AssistantsTable rows={rows} availableScopes={availableScopes} />
        </section>
      </PageContent>
    </Main>
  );
}
