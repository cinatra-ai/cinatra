import type { Metadata } from "next";
import { requireAuthSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { AccountViewClient } from "@/components/account-view-client";

export const metadata: Metadata = { title: "Account Security" };
export const dynamic = "force-dynamic";

export default async function AccountSecurityPage() {
  await requireAuthSession();

  return (
    <Main className="min-h-screen">
      <PageHeader title="Account security" />
      <PageContent className="flex flex-col gap-6 pb-8">
        <AccountViewClient view="security" />
      </PageContent>
    </Main>
  );
}
