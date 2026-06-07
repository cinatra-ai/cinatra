import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { MetricUsageOverviewScreen } from "@cinatra-ai/metric-usage-api/screens";
import { MetricApiNav } from "@/components/metric-api-nav";
import Link from "next/link";
import { Settings2 } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "LLM Usage | Cinatra" };

export default async function MetricUsageApiPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminSession();
  const params = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const days = [7, 30, 90].includes(Number(params.days)) ? Number(params.days) : 30;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="LLM Usage"
        actions={
          <Link href="/analytics/llm/pricing" aria-label="Pricing administration">
            <Settings2 className="h-5 w-5 text-muted-foreground hover:text-foreground transition" />
          </Link>
        }
        divider={false}
      />
      <MetricApiNav activeTab="usage" />
      <PageContent className="flex flex-col gap-6 pb-8">
        <MetricUsageOverviewScreen days={days} />
      </PageContent>
    </Main>
  );
}
