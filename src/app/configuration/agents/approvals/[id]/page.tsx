import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/auth-session";
import { AgentApprovalDetailScreen } from "@cinatra-ai/agents/screens";

export const metadata: Metadata = { title: "Agent Creation Request" };

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminSession();
  const { id } = await params;
  // The post-decision redirect result (?status=/?error=) surfaces via the
  // <SearchParamToast> island mounted inside the screen (codes-only), so the
  // page no longer threads the params (cinatra#391 → toast migration).
  return <AgentApprovalDetailScreen id={id} />;
}
