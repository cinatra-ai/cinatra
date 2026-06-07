import type { Metadata } from "next";
import { requireAuthSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { AccountViewClient } from "@/components/account-view-client";

export const metadata: Metadata = { title: "Account Administration" };
export const dynamic = "force-dynamic";

export default async function AccountSettingsRoutePage({
  params,
}: {
  params: Promise<{ path: string }>;
}) {
  await requireAuthSession();
  const { path } = await params;

  return (
    <Main className="min-h-screen">
      <PageHeader title="Account administration" />
      <PageContent className="flex flex-col gap-6 pb-8">
        <AccountViewClient view={path as "administration" | "security"} />
      </PageContent>
    </Main>
  );
}
