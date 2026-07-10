import "server-only";

import { readConnectorConfigFromDatabase } from "@/lib/database";
import { countOtherPlatformAdmins } from "@/lib/better-auth-db";
import { listAgentCreationRequests } from "@/lib/agent-creation-requests-store";

import { AGENT_SOURCE_ID } from "../resolve-active-view";
import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for the agent-creation-requests source (cinatra#1283).
//
// Holds ONLY the fields the sidebar badge needs — availability / appliesTo /
// counts — plus the two eligibility helpers that both `counts()` (here) and the
// heavy source's `fetchInbox` share. It imports the agent-creation-request STORE
// and the platform-admin count, but NEVER `../decision-helpers`
// (→ `@cinatra-ai/agents/mcp-handlers`) nor `../agent-decision-actions`, so the
// root layout that consumes it via `nav-registry` stays off the agents runtime.
//
// The heavy `agent-creation-requests.ts` source SPREADS this object, so the
// nav registry and the full registry share the exact same function references
// (enforced by `registry-parity.test.ts`).
// ---------------------------------------------------------------------------

/** Mirror of the decide primitive's `connector_config.agent_creation.allowSelfApproval`
 *  read (canonical owner: the agent-creation-request MCP handler) so the Inbox
 *  self-inclusion matches when a self-approval would actually be permitted. */
export function isSelfApprovalAllowed(): boolean {
  try {
    const cfg = readConnectorConfigFromDatabase<{ allowSelfApproval?: boolean }>("agent_creation", {});
    return cfg.allowSelfApproval === true;
  } catch {
    return false;
  }
}

/** Whether `viewer` may clear their OWN proposal (single-admin exception, or the
 *  connector_config override). Matches the decide primitive's SoD guard. */
export async function viewerMayApproveOwn(viewer: ApprovalViewer): Promise<boolean> {
  if (isSelfApprovalAllowed()) return true;
  const otherAdmins = await countOtherPlatformAdmins(viewer.userId);
  return otherAdmins === 0;
}

export const agentCreationRequestsContract = {
  id: AGENT_SOURCE_ID,

  availability() {
    // Local source — always exists for an org'd viewer (admins see Inbox+Mine,
    // any author sees Mine). Per-direction visibility is handled by appliesTo.
    return "ready";
  },

  appliesTo(viewer: ApprovalViewer, direction) {
    // Mine is available to any author; Inbox is admin-only (no admin fetch, no
    // leak, for a non-admin) — decided WITHOUT a privileged fetch.
    return direction === "mine" ? true : viewer.isAdmin;
  },

  async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
    // Ignores any history filter — always the actionable/in-flight count.
    let inbox = 0;
    if (viewer.isAdmin) {
      const proposed = listAgentCreationRequests({ orgId: viewer.orgId, status: "proposed" });
      const includeOwn =
        proposed.some((r) => r.authorId === viewer.userId) && (await viewerMayApproveOwn(viewer));
      inbox = proposed.filter((r) => r.authorId !== viewer.userId || includeOwn).length;
    }
    const mine = listAgentCreationRequests({
      orgId: viewer.orgId,
      authorId: viewer.userId,
      status: "proposed",
    }).length;
    return { inbox, mine };
  },
} satisfies ApprovalNavSource;
