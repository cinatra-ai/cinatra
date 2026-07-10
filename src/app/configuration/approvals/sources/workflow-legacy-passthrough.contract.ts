import "server-only";

import { countPendingWorkflowApprovalsForOrg } from "@cinatra-ai/workflows/store";

import { WORKFLOW_SOURCE_ID } from "../resolve-active-view";
import type { ApprovalNavSource, ApprovalViewer, Direction, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for the workflow legacy passthrough (cinatra#1283).
//
// Read-only mirror: `inboxActionable: false`, so although it applies to every
// org member's Inbox it does NOT, on its own, light the sidebar nav (v1 stays
// admin-only). Holds id / inboxActionable / availability / appliesTo / counts;
// imports only the workflows store count fn (a package boundary), never the
// row renderer or a decide surface. Removed whole by the workflow-tables drop.
// ---------------------------------------------------------------------------

export const workflowLegacyPassthroughContract = {
  id: WORKFLOW_SOURCE_ID,

  // Read-only mirror — rows are decided on the workflow detail page. Applies to
  // every org member's Inbox but does not light the nav on its own.
  inboxActionable: false,

  availability() {
    return "ready";
  },

  appliesTo(_viewer: ApprovalViewer, direction: Direction) {
    // Inbox only — a workflow "Your requests" view is out of v1.
    return direction === "inbox";
  },

  async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
    const inbox = viewer.orgId ? await countPendingWorkflowApprovalsForOrg(viewer.orgId) : 0;
    return { inbox, mine: 0 };
  },
} satisfies ApprovalNavSource;
