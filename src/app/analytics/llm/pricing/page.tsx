import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdminSession } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { MetricsCostPricingScreen } from "@cinatra-ai/metric-cost-api";
import { CrumbContributions } from "@/components/crumb-contributions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Model Pricing | Cinatra" };

// Admin management sub-page of /analytics/llm (cinatra#1910): it edits the
// price list, so it deliberately renders no analytics tab strip.
export default async function MetricsCostPricingPage() {
  await requireAdminSession();
  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher (cinatra#1737): middle crumb "LLM", leaf
          "Pricing" — the crumb contract beats the header title broadcast. */}
      <CrumbContributions
        entries={[
          { prefix: "/analytics/llm", label: "LLM" },
          { prefix: "/analytics/llm/pricing", label: "Pricing" },
        ]}
      />
      <PageHeader
        title="Model pricing"
        description="Manage the per-model price list used to compute LLM spend."
        actions={
          <Button asChild variant="outline">
            <Link href="/analytics/llm">
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              Back to LLM costs
            </Link>
          </Button>
        }
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <MetricsCostPricingScreen />
      </PageContent>
    </Main>
  );
}
