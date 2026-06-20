import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsListRow, TabsTrigger } from "@/components/ui/tabs";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";
import { pendingApprovalsCount } from "@/lib/pending-approvals-count";

import { resolveApprovalsActiveTab } from "./resolve-active-tab";
import { WorkflowApprovalsBody } from "./workflow-approvals-body";
import { AgentApprovalInboxBody } from "@cinatra-ai/agents/screens";

export const metadata: Metadata = { title: "Approvals" };

// Small count chip shown on a tab trigger when that inbox has pending items.
// Mirrors the sidebar pill shape (compact, primary-tinted) without the
// sidebar-only `ml-auto` placement.
function TabCountPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Badge variant="default" className="min-w-5 px-1 text-[10px]">
      {count > 99 ? "99+" : count}
    </Badge>
  );
}

// — unified approvals page with two tabs:
//   • Workflows                — visible to any actor with workflow read access
//                                in their active org (mirrors the prior /approvals
//                                inbox semantics).
//   • Agent creation requests  — admin-only. The tab trigger is not rendered
//                                for non-admin actors, and a non-admin who
//                                visits ?tab=agents directly is server-side
//                                redirected to ?tab=workflows. The agent body
//                                is never fetched for non-admin actors.
//
// Default landing (issue #390): the sidebar "Approvals" pill links here with NO
// `?tab=`, and its badge aggregates BOTH pending workflow approvals AND admin
// agent creation requests. Defaulting to a fixed Workflows tab meant that when
// the only pending item was an agent request, the badge sent the user to an
// empty "No pending approvals" view. So when no tab is explicitly requested we
// land on the tab that actually has pending work: if there are zero pending
// workflow approvals but ≥1 pending agent request (admin only), default to the
// Agents tab; otherwise Workflows. An explicit `?tab=` is always honored. The
// tab triggers also surface their own pending count so it's obvious where the
// item is even when both inboxes are non-empty.

export default async function AdministrationApprovalsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string>>;
}) {
  const session = await getAuthSession();
  const isAdmin = isPlatformAdmin(session);

  const params = (await searchParams) ?? {};
  const explicitTab = params.tab;
  const requestedAgents = explicitTab === "agents";

  if (requestedAgents && !isAdmin) {
    redirect("/configuration/approvals?tab=workflows");
  }

  // Per-tab pending counts drive both the smart default and the trigger pills.
  // `pendingApprovalsCount()` is auth-aware — `agentRequests` is 0 for
  // non-admin actors — so we never leak agent data into a non-admin view.
  // Soft-fail to zeros so a transient count error never blanks the page.
  let pendingWorkflows = 0;
  let pendingAgents = 0;
  try {
    const counts = await pendingApprovalsCount();
    pendingWorkflows = counts.workflows;
    pendingAgents = counts.agentRequests;
  } catch {
    // Counts are best-effort; the page still renders with both tabs at 0.
  }

  // Resolve the active tab. An explicit `?tab=` always wins. Otherwise default
  // to the populated tab: only steer to Agents when Workflows is empty AND
  // there is at least one pending agent request (admin only). Never default a
  // non-admin to Agents (pendingAgents is already 0 for them).
  const activeTab = resolveApprovalsActiveTab({
    explicitTab,
    pendingWorkflows,
    pendingAgents,
  });

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
        <Tabs defaultValue={activeTab}>
          <TabsListRow>
            <TabsTrigger value="workflows" asChild>
              <Link
                href="/configuration/approvals?tab=workflows"
                scroll={false}
                className="inline-flex items-center gap-2"
              >
                Workflows
                <TabCountPill count={pendingWorkflows} />
              </Link>
            </TabsTrigger>
            {isAdmin && (
              <TabsTrigger value="agents" asChild>
                <Link
                  href="/configuration/approvals?tab=agents"
                  scroll={false}
                  className="inline-flex items-center gap-2"
                >
                  Agents
                  <TabCountPill count={pendingAgents} />
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
