import "server-only";

import { agentCreationRequestsSource } from "./agent-creation-requests";
import { workflowLegacyPassthroughSource } from "./workflow-legacy-passthrough";
import type { ApprovalSource, ApprovalViewer } from "./types";

// ---------------------------------------------------------------------------
// Ordered approval-source registry. Local sources first; the marketplace
// sources append here in a later slice. The array order is the section render
// order within each direction tab. A source is removed by deleting its adapter
// file + its entry here (the workflow passthrough is deleted whole by #1035).
// ---------------------------------------------------------------------------

export const approvalSourceRegistry: ApprovalSource[] = [
  agentCreationRequestsSource,
  workflowLegacyPassthroughSource,
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
