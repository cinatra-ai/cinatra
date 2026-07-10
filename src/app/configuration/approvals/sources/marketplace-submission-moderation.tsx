import "server-only";

import { formatDistanceToNow } from "date-fns";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type { MarketplaceAdminSubmission } from "@cinatra-ai/marketplace-mcp-client";

import { MarketplaceDecisionActions } from "../marketplace-decision-actions";
import { decideMarketplaceSubmission } from "../marketplace-decision-helpers";
import { MarketplaceRowView, type MarketplaceBadgeVariant } from "./marketplace-row";
import {
  MARKETPLACE_GROUP,
  MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID,
  MARKETPLACE_SUBMISSIONS_ADMIN_HREF,
  REMOTE_COUNT_CAP,
  cappedCount,
  guardedCount,
  guardedFetch,
  hasInstanceToken,
  marketplaceAvailability,
  resolveInstanceToken,
  toRowEligibility,
} from "./marketplace-shared";
import type { ApprovalAction, ApprovalRow, ApprovalSource, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// Marketplace source #1 — extension-submission MODERATION (Inbox only).
//
// The moderator queue of all vendors' pending extension submissions. Credential:
// `MARKETPLACE_INSTANCE_TOKEN` (mirrors the drill-down admin queue page exactly).
// Approve / Reject decide at the marketplace through the non-redirecting helper;
// the marketplace's WP cap + separation-of-duties are the authoritative gate and
// surface as readable #1046 text at action time.
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID;
const LIST_LIMIT = 200;

const MODERATE_ACTIONS: ApprovalAction[] = [
  { id: "approve", label: "Approve", enforcement: "action-time" },
  { id: "reject", label: "Reject", intent: "destructive", enforcement: "action-time", requiresReason: true },
];

interface SubmissionRaw {
  vendorId: number;
  promotionState: string;
}

function statusVariant(status: string): MarketplaceBadgeVariant {
  switch (status) {
    case "approved":
    case "promoted":
      return "default";
    case "rejected":
      return "destructive";
    case "pending":
      return "secondary";
    default:
      return "outline";
  }
}

function toRow(s: MarketplaceAdminSubmission): ApprovalRow {
  const raw: SubmissionRaw = { vendorId: s.vendor_id, promotionState: s.promotion_state };
  return {
    id: s.submission_id,
    sourceId: SOURCE_ID,
    title: s.target_final_identity,
    subtitle: `vendor #${s.vendor_id}`,
    status: s.status,
    createdAt: s.submitted_at,
    eligibility: toRowEligibility(s.eligibility),
    raw,
  };
}

export const marketplaceSubmissionModerationSource: ApprovalSource = {
  id: SOURCE_ID,
  title: "Extension submissions",
  group: MARKETPLACE_GROUP,

  viewAllHref: (dir) => (dir === "inbox" ? MARKETPLACE_SUBMISSIONS_ADMIN_HREF : undefined),

  availability: () => marketplaceAvailability(),

  appliesTo: (viewer, direction) => viewer.isAdmin && direction === "inbox",

  // Per-direction credential gate — its own `MARKETPLACE_INSTANCE_TOKEN`.
  sectionConfigured: () => hasInstanceToken(),

  async fetchInbox(viewer) {
    return guardedFetch(viewer, resolveInstanceToken(), MODERATE_ACTIONS, async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      const out = await client.extensionSubmissionListAdmin({ status: "pending", limit: LIST_LIMIT });
      return out.submissions.map(toRow);
    });
  },

  async fetchMine() {
    // Inbox-only source; "Your requests" is served by the my-submissions source.
    return { availability: "ready", rows: [], actions: [] };
  },

  async counts(viewer): Promise<SourceCounts> {
    const inbox = await guardedCount(viewer, resolveInstanceToken(), `${SOURCE_ID}:inbox`, async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      const out = await client.extensionSubmissionListAdmin({
        status: "pending",
        limit: REMOTE_COUNT_CAP + 1,
      });
      return cappedCount(out.submissions.length);
    });
    return { inbox, mine: 0 };
  },

  rowRenderer(row: ApprovalRow) {
    const raw = (row.raw ?? {}) as SubmissionRaw;
    const submitted = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });
    const promo =
      raw.promotionState && raw.promotionState !== "none" ? ` · promotion ${raw.promotionState}` : "";
    return (
      <MarketplaceRowView
        title={row.title}
        statusLabel={row.status}
        statusVariant={statusVariant(row.status)}
        meta={`vendor #${raw.vendorId} · submitted ${submitted}${promo}`}
        right={
          <MarketplaceDecisionActions
            sourceId={SOURCE_ID}
            rowId={row.id}
            mode="moderate"
            eligibility={row.eligibility}
            detailsHref={MARKETPLACE_SUBMISSIONS_ADMIN_HREF}
          />
        }
      />
    );
  },

  actions: { decide: decideMarketplaceSubmission },
};
