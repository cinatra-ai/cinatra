import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/auth-session";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { MetricsTracesScreen } from "@cinatra-ai/metric-cost-api";
import { MetricApiNav } from "@/components/metric-api-nav";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "API Requests | Cinatra" };

export default async function MetricsTracesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminSession();
  const params = await (searchParams ??
    Promise.resolve({} as Record<string, string | string[] | undefined>));
  const runId = typeof params.runId === "string" ? params.runId : undefined;
  const str = (v: string | string[] | undefined) =>
    typeof v === "string" ? v : undefined;
  const from = str(params.from);
  const to = str(params.to);
  const service = str(params.service);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="API Requests"
        description={
          runId
            ? `API request trace for agent run ${runId}`
            : "API request traces and span-level execution visibility for agents"
        }
        divider={false}
      />
      <MetricApiNav activeTab="traces" />
      <PageContent className="flex flex-col gap-6 pb-8">
        <MetricsTracesScreen runId={runId} from={from} to={to} service={service} />
      </PageContent>
    </Main>
  );
}
