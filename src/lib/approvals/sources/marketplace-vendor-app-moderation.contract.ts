import "server-only";

import {
  createMarketplaceClient,
  MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID,
  REMOTE_COUNT_CAP,
  cappedCount,
  guardedCount,
  isRegisteredVendor,
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
    // Gate the badge count on the strict registration predicate too — an admin-
    // token instance that is not a registered vendor contributes 0 (owner
    // ruling: no vendor info unless a registered vendor), not just when the admin
    // token is absent.
    const sectionToken = isRegisteredVendor() ? resolveAdminToken() : undefined;
    const inbox = await guardedCount(viewer, sectionToken, `${SOURCE_ID}:inbox`, async (token) => {
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
