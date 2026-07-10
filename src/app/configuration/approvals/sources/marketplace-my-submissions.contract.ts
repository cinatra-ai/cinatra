import "server-only";

import {
  createMarketplaceClient,
  MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID,
  cappedCount,
  guardedCount,
  marketplaceAvailability,
  resolveInstanceToken,
} from "./marketplace-shared";
import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for the MY extension-submissions source
// (cinatra#1283). "Your requests"-only — see the submission-moderation contract
// for the split rationale. id / availability / appliesTo / counts only.
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID;

export const marketplaceMySubmissionsContract = {
  id: SOURCE_ID,

  availability: () => marketplaceAvailability(),

  appliesTo: (viewer: ApprovalViewer, direction) => viewer.isAdmin && direction === "mine",

  async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
    // "mine" counts the in-flight (still-pending, withdrawable) submissions.
    const mine = await guardedCount(viewer, resolveInstanceToken(), `${SOURCE_ID}:mine`, async (token) => {
      const client = createMarketplaceClient(token);
      const out = await client.extensionSubmissionListSelf();
      return cappedCount(out.submissions.filter((s) => s.status === "pending").length);
    });
    return { inbox: 0, mine };
  },
} satisfies ApprovalNavSource;
