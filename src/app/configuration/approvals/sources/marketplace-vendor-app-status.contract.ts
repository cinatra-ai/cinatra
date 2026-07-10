import "server-only";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";

import {
  MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID,
  guardedCount,
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
    // The instance's application is "in flight" only while `applied`.
    const mine = await guardedCount(viewer, resolveVendorToken(), `${SOURCE_ID}:mine`, async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      const status = await client.vendorApplicationStatus();
      return status.state === "applied" ? 1 : 0;
    });
    return { inbox: 0, mine };
  },
} satisfies ApprovalNavSource;
