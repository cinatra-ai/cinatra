import "server-only";

import {
  createMarketplaceClient,
  MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID,
  REMOTE_COUNT_CAP,
  cappedCount,
  guardedCount,
  marketplaceAvailability,
  resolveInstanceToken,
} from "./marketplace-shared";
import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for the extension-submission MODERATION source
// (cinatra#1283). Holds ONLY id / availability / appliesTo / counts — the fields
// the sidebar badge consumes. Uses the shared marketplace client factory +
// credential/count guards, but NEVER `../marketplace-decision-actions` (React
// client) nor `../marketplace-decision-helpers`, so the root layout that reads
// it via `nav-registry` never drags the decide/render surface into every
// route's build graph. The heavy `.tsx` source SPREADS this object, so the nav
// and full registries share the SAME function references (registry-parity.test).
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID;

export const marketplaceSubmissionModerationContract = {
  id: SOURCE_ID,

  availability: () => marketplaceAvailability(),

  appliesTo: (viewer: ApprovalViewer, direction) => viewer.isAdmin && direction === "inbox",

  async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
    const inbox = await guardedCount(viewer, resolveInstanceToken(), `${SOURCE_ID}:inbox`, async (token) => {
      const client = createMarketplaceClient(token);
      const out = await client.extensionSubmissionListAdmin({
        status: "pending",
        limit: REMOTE_COUNT_CAP + 1,
      });
      return cappedCount(out.submissions.length);
    });
    return { inbox, mine: 0 };
  },
} satisfies ApprovalNavSource;
