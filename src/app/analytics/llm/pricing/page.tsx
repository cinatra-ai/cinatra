import type { Metadata } from "next";
import Link from "next/link";
import { Settings2 } from "lucide-react";
import { requireAdminSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { MetricsCostPricingScreen } from "@cinatra-ai/metric-cost-api";
import { MetricApiNav } from "@/components/metric-api-nav";
import { analyticsTabDescription } from "@/lib/section-nav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Model Pricing | Cinatra" };

export default async function MetricsCostPricingPage() {
  await requireAdminSession();
  return (
    <Main className="min-h-screen">
      <PageHeader
        title="LLM"
        description={analyticsTabDescription("costs")}
        actions={
          <Link href="/analytics/llm/pricing" aria-label="Pricing administration">
            <Settings2 className="h-5 w-5 text-muted-foreground hover:text-foreground transition" />
          </Link>
        }
        divider={false}
      />
      <MetricApiNav activeTab="costs" />
      <PageContent className="flex flex-col gap-6 pb-8">
        <MetricsCostPricingScreen />
      </PageContent>
    </Main>
  );
}
