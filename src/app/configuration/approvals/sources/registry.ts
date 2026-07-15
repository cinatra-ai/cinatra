import "server-only";

import { agentCreationRequestsSource } from "./agent-creation-requests";
import { hostPortGrantsSource } from "./host-port-grants";
import { dynamicTypeArtifactVisibilitySource } from "./dynamic-type-artifact-visibility";
import { marketplaceSubmissionModerationSource } from "./marketplace-submission-moderation";
import { marketplaceVendorAppModerationSource } from "./marketplace-vendor-app-moderation";
import { marketplaceMySubmissionsSource } from "./marketplace-my-submissions";
import { marketplaceVendorAppStatusSource } from "./marketplace-vendor-app-status";
import type { ApprovalSource, ApprovalViewer } from "./types";

// ---------------------------------------------------------------------------
// Ordered approval-source registry. Local sources first, then the marketplace
// group. The array order is the section render order within each direction tab:
//   Inbox         → agent, host-port grants, dynamic-type coverage,
//                   submission-moderation, vendor-app-moderation
//   Your requests → agent, my-submissions, vendor-app-status
// A source is removed by deleting its adapter file + its entry here (the
// workflow passthrough was deleted whole by #1035). The four marketplace sources
// share `group: "marketplace"` so the page collapses them into ONE "not
// connected" state + ONE footer when no marketplace credential resolves.
// ---------------------------------------------------------------------------

export const approvalSourceRegistry: ApprovalSource[] = [
  agentCreationRequestsSource,
  hostPortGrantsSource,
  dynamicTypeArtifactVisibilitySource,
  marketplaceSubmissionModerationSource,
  marketplaceVendorAppModerationSource,
  marketplaceMySubmissionsSource,
  marketplaceVendorAppStatusSource,
];

/**
 * Sources whose section may be rendered for this viewer, in registry order.
 * Drops any source whose coarse `availability` is `not_configured` (a
 * misconfigured/hidden source) — inert for the v1 local sources, which are
 * always `ready`. Per-direction visibility is then decided by `appliesTo`.
 */
export async function availableSources(viewer: ApprovalViewer): Promise<ApprovalSource[]> {
  const decided = await Promise.all(
    approvalSourceRegistry.map(async (source) => ({
      source,
      availability: await source.availability(viewer),
    })),
  );
  return decided.filter((d) => d.availability !== "not_configured").map((d) => d.source);
}
