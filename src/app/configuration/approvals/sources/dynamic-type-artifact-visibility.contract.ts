import "server-only";

import { countUnapprovedDynamicTypes } from "@/lib/objects/artifact-visibility-approval";

import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for the dynamic-type artifact-visibility source
// (cinatra#1433, pattern per cinatra#1283/#1391).
//
// Holds ONLY availability / appliesTo / counts. The count composes the
// visibility-approval backend's read helpers (active dynamic types × the org's
// claim registry) — NEVER `../decision-helpers`, the heavy source's
// rowRenderer/decide surface, or the React client decision component — so the
// root layout that consumes it via `nav-registry` stays off the heavy graph
// (nav-registry-import-purity). The heavy `dynamic-type-artifact-visibility.ts`
// source SPREADS this object (same function references; enforced by
// `registry-parity.test.ts`).
// ---------------------------------------------------------------------------

export const DYNAMIC_TYPE_VISIBILITY_SOURCE_ID = "dynamic-type-artifact-visibility";

export const dynamicTypeArtifactVisibilityContract = {
  id: DYNAMIC_TYPE_VISIBILITY_SOURCE_ID,

  availability() {
    // Local source — the dynamic-type table and the claim registry always
    // exist; per-direction visibility is handled by appliesTo.
    return "ready";
  },

  appliesTo(viewer: ApprovalViewer, direction) {
    // Inbox is admin-only: approving artifact coverage changes how every org
    // member sees rows of the type. Dynamic types are minted by the classifier
    // / MCP / install machinery, never requested by a user — there is no
    // "Your requests" view.
    return direction === "inbox" ? viewer.isAdmin : false;
  },

  async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
    if (!viewer.isAdmin) return { inbox: 0, mine: 0 };
    const inbox = await countUnapprovedDynamicTypes({ orgId: viewer.orgId });
    return { inbox, mine: 0 };
  },
} satisfies ApprovalNavSource;
