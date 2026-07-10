import { Suspense } from "react";
import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/auth-session";
import { AgentApprovalDetailScreen } from "@cinatra-ai/agents/screens";
import { SearchParamToast } from "@/components/search-param-toast";
import { APPROVAL_DECISION_TOASTS } from "./approval-decision-flash";

export const metadata: Metadata = { title: "Agent Creation Request" };

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminSession();
  const { id } = await params;
  // The post-decision redirect result (?status=/?error=) surfaces via the
  // codes-only <SearchParamToast> island mounted HERE (cinatra#391 → toast
  // migration). The island is mounted at the page — not inside
  // AgentApprovalDetailScreen — so the client toast module stays OUT of the
  // @cinatra-ai/agents screens graph, which the server API routes reach
  // (route-graph ratchet). The page still passes only `id`; the island reads
  // the params from the URL client-side.
  return (
    <>
      <Suspense fallback={null}>
        <SearchParamToast toasts={APPROVAL_DECISION_TOASTS} />
      </Suspense>
      <AgentApprovalDetailScreen id={id} />
    </>
  );
}
