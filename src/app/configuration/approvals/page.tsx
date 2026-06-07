import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Tabs, TabsContent, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

import { WorkflowApprovalsBody } from "./workflow-approvals-body";
import { AgentApprovalInboxBody } from "@cinatra-ai/agents/screens";

export const metadata: Metadata = { title: "Approvals" };

// — unified approvals page with two tabs:
//   • Workflows                — visible to any actor with workflow read access
//                                in their active org (mirrors the prior /approvals
//                                inbox semantics).
//   • Agent creation requests  — admin-only. The tab trigger is not rendered
//                                for non-admin actors, and a non-admin who
//                                visits ?tab=agents directly is server-side
//                                redirected to ?tab=workflows. The agent body
//                                is never fetched for non-admin actors.

export default async function AdministrationApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string>>;
}) {
  const session = await getAuthSession();
  const isAdmin = isPlatformAdmin(session);

  const params = (await searchParams) ?? {};
  const requestedTab = params.tab === "agents" ? "agents" : "workflows";

  if (requestedTab === "agents" && !isAdmin) {
    redirect("/configuration/approvals?tab=workflows");
  }

  const statusFilter = params.status ?? "pending";
  // Filter pill base href — the body appends `&status=<value>`. Always carries
  // `tab=agents` so a status change keeps the user on the agents tab.
  const agentsFilterBaseHref = "/configuration/approvals?tab=agents";

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Approvals"
        description="Workflow approvals and agent creation requests awaiting a decision."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <Tabs defaultValue={requestedTab}>
          <TabsListRow>
            <TabsTrigger value="workflows" asChild>
              <Link href="/configuration/approvals?tab=workflows" scroll={false}>
                Workflows
              </Link>
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="agents" asChild>
                <Link href="/configuration/approvals?tab=agents" scroll={false}>
                  Agents
                </Link>
              </TabsTrigger>
            )}
          </TabsListRow>
          <TabsContent value="workflows" className="flex flex-col gap-6">
            <WorkflowApprovalsBody />
          </TabsContent>
          {isAdmin && (
            <TabsContent value="agents" className="flex flex-col gap-6">
              <AgentApprovalInboxBody
                statusFilter={statusFilter}
                filterBaseHref={agentsFilterBaseHref}
              />
            </TabsContent>
          )}
        </Tabs>
      </PageContent>
    </Main>
  );
}
