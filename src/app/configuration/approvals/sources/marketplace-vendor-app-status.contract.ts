import "server-only";

import {
  createMarketplaceClient,
  MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID,
  guardedCount,
  isRegisteredVendor,
  marketplaceAvailability,
  resolveVendorToken,
} from "./marketplace-shared";
import type { ApprovalNavSource, ApprovalViewer, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// IMPORT-LIGHT nav contract for THIS instance's vendor-application STATUS source
// (cinatra#1283). Read-only "Your requests"-only reflection — see the
// submission-moderation contract for the split rationale. id / availability /
// appliesTo / counts only.
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID;

export const marketplaceVendorAppStatusContract = {
  id: SOURCE_ID,

  availability: () => marketplaceAvailability(),

  appliesTo: (viewer: ApprovalViewer, direction) => viewer.isAdmin && direction === "mine",

  async counts(viewer: ApprovalViewer): Promise<SourceCounts> {
    // The instance's application is "in flight" only while `applied`. Gate the
    // badge count on the strict registration predicate too — a non-registered
    // (e.g. consumer-only) instance contributes 0, not just when its token is
    // absent (owner ruling: no vendor info unless a registered vendor).
    const sectionToken = isRegisteredVendor() ? resolveVendorToken() : undefined;
    const mine = await guardedCount(viewer, sectionToken, `${SOURCE_ID}:mine`, async (token) => {
      const client = createMarketplaceClient(token);
      const status = await client.vendorApplicationStatus();
      return status.state === "applied" ? 1 : 0;
    });
    return { inbox: 0, mine };
  },
} satisfies ApprovalNavSource;
