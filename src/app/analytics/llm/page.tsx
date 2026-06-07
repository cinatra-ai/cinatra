import type { Metadata } from "next";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import { requireAdminSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { MetricsCostOverviewScreen } from "@cinatra-ai/metric-cost-api";
import { MetricApiNav } from "@/components/metric-api-nav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "LLM Costs | Cinatra" };

export default async function MetricsCostsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminSession();
  const params = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const days = [7, 30, 90].includes(Number(params.days)) ? Number(params.days) : 30;
  const provider = typeof params.provider === "string" ? params.provider : undefined;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="LLM Costs"
        actions={
          <Link href="/analytics/llm/pricing" aria-label="Pricing administration">
            <Settings2 className="h-5 w-5 text-muted-foreground hover:text-foreground transition" />
          </Link>
        }
        divider={false}
      />
      <MetricApiNav activeTab="costs" />
      <PageContent className="flex flex-col gap-6 pb-8">
        <MetricsCostOverviewScreen days={days} provider={provider} />
      </PageContent>
    </Main>
  );
}
