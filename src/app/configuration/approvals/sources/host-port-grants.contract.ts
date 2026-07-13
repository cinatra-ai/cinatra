import "server-only";

import { countPendingHostPortGrants } from "@/lib/extension-host-port-grants";

import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for the extension host-port-grants source
// (cinatra#1391, pattern per cinatra#1283).
//
// Holds ONLY availability / appliesTo / counts. The count is a single pending-
// grant-table query from the PURE grant STORE — NEVER the union-aware review
// backend (which recomputes the live port union and so reaches the install
// pipeline / MCP registry), the heavy source's rowRenderer / decide surface, or
// the React client decision component — so the root layout that consumes it via
// `nav-registry` stays off the heavy graph (nav-registry-import-purity /
// cinatra#1283). The heavy `host-port-grants.ts` source SPREADS this object
// (same function references; enforced by `registry-parity.test.ts`).
// ---------------------------------------------------------------------------

export const HOST_PORT_GRANTS_SOURCE_ID = "extension-host-port-grants";

export const hostPortGrantsContract = {
  id: HOST_PORT_GRANTS_SOURCE_ID,

  availability() {
    // Local source — the grant table always exists; per-direction visibility
    // is handled by appliesTo.
    return "ready";
  },

  appliesTo(viewer: ApprovalViewer, direction) {
    // Inbox is platform-admin-only (`viewer.isAdmin` mirrors
    // `isPlatformAdmin(session)`): host-port grants convey host capability and
    // platform-scoped (org-less) grant rows are visible here. Grants are
    // requested by the install machinery, never by a user — there is no
    // "Your requests" view.
    return direction === "inbox" ? viewer.isAdmin : false;
  },

  async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
    if (!viewer.isAdmin) return { inbox: 0, mine: 0 };
    const inbox = await countPendingHostPortGrants({ orgIds: [viewer.orgId, null] });
    return { inbox, mine: 0 };
  },
} satisfies ApprovalNavSource;
