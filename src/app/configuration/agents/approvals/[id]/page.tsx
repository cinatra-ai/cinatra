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
  // Platform-admin only (cinatra#2700, epic #2699): the page stays at this URL
  // and falls under the `/configuration` gate like every other route in the
  // segment. The stated consequence of the epic is that a non-admin author
  // loses the read they had — S2 removes the member-facing links that used to
  // mint a path here, so nothing dead-ends. An unauthenticated caller is still
  // redirected to /sign-in; a signed-in non-admin lands on /not-authorized.
  //
  // AgentApprovalDetailScreen keeps its own author-or-admin read rule (it is
  // the layer that reads the row, and the SAME rule serves the token-gated MCP
  // surface) — it is simply no longer reachable by a non-admin through this
  // page.
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
