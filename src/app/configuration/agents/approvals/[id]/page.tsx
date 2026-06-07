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
  return <AgentApprovalDetailScreen id={id} />;
}
