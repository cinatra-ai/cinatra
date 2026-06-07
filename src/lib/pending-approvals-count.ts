import "server-only";

import { countPendingWorkflowApprovalsForOrg } from "@cinatra-ai/workflows/store";
import { countPendingAgentCreationRequests } from "@/lib/agent-creation-requests-store";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

export type PendingApprovalsCount = {
  workflows: number;
  agentRequests: number;
  total: number;
};

/**
 * Aggregate of pending approvals the calling actor can see. Authorization-aware:
 * `agentRequests` is 0 for non-admin actors (they can't see agent creation requests).
 * `workflows` is the existing org-scoped count used by the workflow approvals inbox.
 */
export async function pendingApprovalsCount(): Promise<PendingApprovalsCount> {
  const session = await getAuthSession();
  const orgId = session?.session?.activeOrganizationId ?? null;
  if (!orgId) return { workflows: 0, agentRequests: 0, total: 0 };

  const workflows = await countPendingWorkflowApprovalsForOrg(orgId);
  const agentRequests = isPlatformAdmin(session)
    ? countPendingAgentCreationRequests(orgId)
    : 0;
  return { workflows, agentRequests, total: workflows + agentRequests };
}
