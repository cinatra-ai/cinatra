import "server-only";

import { agentCreationRequestsContract } from "./agent-creation-requests.contract";
import { hostPortGrantsContract } from "./host-port-grants.contract";
import { dynamicTypeArtifactVisibilityContract } from "./dynamic-type-artifact-visibility.contract";
import { marketplaceSubmissionModerationContract } from "./marketplace-submission-moderation.contract";
import { marketplaceVendorAppModerationContract } from "./marketplace-vendor-app-moderation.contract";
import { marketplaceMySubmissionsContract } from "./marketplace-my-submissions.contract";
import { marketplaceVendorAppStatusContract } from "./marketplace-vendor-app-status.contract";
import type { ApprovalNavSource, ApprovalViewer } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav registry (cinatra#1283).
//
// The root layout resolves the sidebar Approvals badge `{ total, visible }` and
// is on EVERY route's build module graph. It must therefore reach the approval
// sources' counts/visibility WITHOUT importing the heavy full `registry.ts`,
// which pulls each source's decide helpers (`../decision-helpers` →
// `@cinatra-ai/agents/mcp-handlers`, the whole agents runtime) and the React
// client decision-action components into the layout graph — the +380MB peak
// build RSS that OOMs CI. So this module imports ONLY the per-source
// `*.contract.ts` light halves.
//
// PROPERTY PRESERVATION — "a new source lights the badge with no sidebar edit":
// this registry enumerates the SAME ordered source list as the full
// `approvalSourceRegistry` (each source = one contract entry here + one heavy
// entry there); `registry-parity.test.ts` fails CI on any id/order drift or if a
// heavy source's counts/appliesTo/availability/inboxActionable stops being the
// SAME function reference as its contract. The full registry stays imported only
// by `page.tsx` / `actions.ts` / `approvals-mcp.ts` (the page/MCP graph, off the
// layout graph).
// ---------------------------------------------------------------------------

export const approvalNavSourceRegistry: ApprovalNavSource[] = [
  agentCreationRequestsContract,
  hostPortGrantsContract,
  dynamicTypeArtifactVisibilityContract,
  marketplaceSubmissionModerationContract,
  marketplaceVendorAppModerationContract,
  marketplaceMySubmissionsContract,
  marketplaceVendorAppStatusContract,
];

/**
 * Nav sources whose section may be rendered for this viewer, in registry order.
 * BYTE-IDENTICAL `not_configured` filter to `availableSources` (the full
 * registry's) so the sidebar badge and the page derive visibility/counts from
 * the exact same available set — a `not_configured` source affects neither.
 */
export async function availableNavSources(viewer: ApprovalViewer): Promise<ApprovalNavSource[]> {
  const decided = await Promise.all(
    approvalNavSourceRegistry.map(async (source) => ({
      source,
      availability: await source.availability(viewer),
    })),
  );
  return decided.filter((d) => d.availability !== "not_configured").map((d) => d.source);
}
