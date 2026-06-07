import type { Metadata } from "next";
import { OrganizationSwitcher, OrganizationView } from "@daveyplate/better-auth-ui";
import { requireAdminSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { SidebarNav } from "@/components/sidebar-nav";

export const metadata: Metadata = { title: "Workspace" };

const navItems = [
  { href: "/configuration/workspace", title: "Administration" },
  { href: "/configuration/workspace/members", title: "Members" },
];

export default async function WorkspaceSettingsPage() {
  await requireAdminSession();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Workspace"
        description="Manage workspace details, members, invitations, and related access controls."
        actions={
          <OrganizationSwitcher
            hidePersonal
            classNames={{
              base: "w-auto",
              trigger: {
                base: "inline-flex h-11 items-center gap-2 rounded-control border border-input bg-background px-3 text-sm font-medium text-foreground shadow-sm transition hover:bg-accent",
                avatar: {
                  base: "h-5 w-5 rounded-chip",
                  image: "rounded-chip",
                  fallback: "rounded-chip text-[10px]",
                },
              },
              content: {
                base: "rounded-control border border-line bg-surface-strong p-1.5 shadow-[0_24px_48px_rgba(15,23,42,0.16)] backdrop-blur-xl",
                menuItem: "rounded-chip px-3 py-2 text-sm font-medium text-foreground transition hover:bg-surface-muted",
                separator: "my-1 bg-line",
              },
            }}
          />
        }
      />
      <PageContent>
        <div className="flex w-full grow flex-col gap-4 md:flex-row md:gap-12">
          <aside className="mb-6 md:mb-0 md:w-48 lg:w-56">
            <SidebarNav items={navItems} />
          </aside>
          <div className="min-w-0 flex-1">
            <OrganizationView
              path="settings"
              hideNav
              classNames={{
                cards: "grid grid-cols-1 gap-4 md:grid-cols-2 [&>*:last-child]:md:col-span-2",
                card: {
                  base: "border border-line bg-surface backdrop-blur-none rounded-card",
                  header: "px-6 pt-6",
                  content: "px-6",
                  footer: "px-6 pb-6",
                },
              }}
            />
          </div>
        </div>
      </PageContent>
    </Main>
  );
}
