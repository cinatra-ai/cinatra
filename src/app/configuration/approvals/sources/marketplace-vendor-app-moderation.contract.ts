import "server-only";

import {
  createMarketplaceClient,
  MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID,
  REMOTE_COUNT_CAP,
  cappedCount,
  guardedCount,
  marketplaceAvailability,
  resolveAdminToken,
} from "./marketplace-shared";
import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for the vendor-application MODERATION source
// (cinatra#1283). See the submission-moderation contract for the split rationale
// — id / availability / appliesTo / counts only, off the decide/render surface.
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID;

export const marketplaceVendorAppModerationContract = {
  id: SOURCE_ID,

  availability: () => marketplaceAvailability(),

  appliesTo: (viewer: ApprovalViewer, direction) => viewer.isAdmin && direction === "inbox",

  async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
    const inbox = await guardedCount(viewer, resolveAdminToken(), `${SOURCE_ID}:inbox`, async (token) => {
      const client = createMarketplaceClient(token);
      const out = await client.vendorApplicationListAdmin({
        status: ["applied"],
        limit: REMOTE_COUNT_CAP + 1,
      });
      return cappedCount(out.rows.length);
    });
    return { inbox, mine: 0 };
  },
} satisfies ApprovalNavSource;
