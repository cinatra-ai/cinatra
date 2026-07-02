import type { Metadata } from "next";
import { requireAdminSession } from "@/lib/auth-session";
import { AgentApprovalDetailScreen } from "@cinatra-ai/agents/screens";

export const metadata: Metadata = { title: "Agent Creation Request" };

export default async function ApprovalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminSession();
  const { id } = await params;
  // Thread the post-decision redirect result through to the screen so a failed
  // approve/reject (?error=…) is surfaced instead of looking like a silent
  // reload (cinatra#391; mirrors the Instance-tab fix in #357).
  const resolvedSearchParams = searchParams ? await searchParams : {};
  return (
    <AgentApprovalDetailScreen
      id={id}
      error={resolvedSearchParams.error}
      status={resolvedSearchParams.status}
    />
  );
}
