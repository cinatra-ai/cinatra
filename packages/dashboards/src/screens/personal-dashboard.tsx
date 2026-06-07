import "server-only";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { getAuthSession } from "@/lib/auth-session";

import { buildSecurityContextFromSession } from "../auth/security-context";
import { DashboardsClientShell } from "../components/dashboards-client-shell";
import { DeskDashboardGrid } from "../components/desk-dashboard-grid";

export async function PersonalDashboardPage() {
  const session = await getAuthSession();
  const ctx = buildSecurityContextFromSession(session);
  if (!ctx) {
    redirect("/sign-in");
  }

  return (
    <Main className="min-h-screen">
      <PageHeader title="Personal" divider={false} />
      <PageContent className="flex flex-col gap-6 pb-8">
        <DashboardsClientShell>
          <DeskDashboardGrid />
        </DashboardsClientShell>
      </PageContent>
    </Main>
  );
}
