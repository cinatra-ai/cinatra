import "server-only";

import { formatDistanceToNow } from "date-fns";
import Link from "next/link";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type { MarketplaceVendorSubmission } from "@cinatra-ai/marketplace-mcp-client";

import { MarketplaceDecisionActions } from "../marketplace-decision-actions";
import { withdrawMarketplaceSubmission } from "../marketplace-decision-helpers";
import { MarketplaceRowView, type MarketplaceBadgeVariant } from "./marketplace-row";
import {
  MARKETPLACE_GROUP,
  MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID,
  MARKETPLACE_SUBMISSIONS_SELF_HREF,
  cappedCount,
  guardedCount,
  guardedFetch,
  hasInstanceToken,
  marketplaceAvailability,
  resolveInstanceToken,
} from "./marketplace-shared";
import type { ApprovalAction, ApprovalRow, ApprovalSource, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// Marketplace source #3 — MY extension submissions ("Your requests" only).
//
// The instance's own submitted tarballs awaiting moderator review. Credential:
// `MARKETPLACE_INSTANCE_TOKEN` (mirrors the my-submissions page). The only
// mutation is Withdraw on a still-pending row; approve/reject live on the
// moderation source. Labeled as this instance's requests — these await OTHERS.
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_MY_SUBMISSIONS_SOURCE_ID;

const WITHDRAW_ACTIONS: ApprovalAction[] = [
  { id: "withdraw", label: "Withdraw", enforcement: "action-time" },
];

interface MySubmissionRaw {
  promotionState: string;
  promotionError: string | null;
  decisionReason: string | null;
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

function toRow(s: MarketplaceVendorSubmission): ApprovalRow {
  const raw: MySubmissionRaw = {
    promotionState: s.promotion_state,
    promotionError: s.promotion_error,
    decisionReason: s.decision_reason,
  };
  return {
    id: s.submission_id,
    sourceId: SOURCE_ID,
    title: s.target_final_identity,
    status: s.status,
    createdAt: s.submitted_at,
    raw,
  };
}

export const marketplaceMySubmissionsSource: ApprovalSource = {
  id: SOURCE_ID,
  title: "This instance's extension submissions",
  group: MARKETPLACE_GROUP,

  viewAllHref: (dir) => (dir === "mine" ? MARKETPLACE_SUBMISSIONS_SELF_HREF : undefined),

  availability: () => marketplaceAvailability(),

  appliesTo: (viewer, direction) => viewer.isAdmin && direction === "mine",

  sectionConfigured: () => hasInstanceToken(),

  async fetchInbox() {
    // "Your requests"-only source; moderation is the submission-moderation source.
    return { availability: "ready", rows: [], actions: [] };
  },

  async fetchMine(viewer) {
    return guardedFetch(viewer, resolveInstanceToken(), WITHDRAW_ACTIONS, async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      const out = await client.extensionSubmissionListSelf();
      return out.submissions.map(toRow);
    });
  },

  async counts(viewer): Promise<SourceCounts> {
    // "mine" counts the in-flight (still-pending, withdrawable) submissions.
    const mine = await guardedCount(viewer, resolveInstanceToken(), `${SOURCE_ID}:mine`, async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      const out = await client.extensionSubmissionListSelf();
      return cappedCount(out.submissions.filter((s) => s.status === "pending").length);
    });
    return { inbox: 0, mine };
  },

  rowRenderer(row: ApprovalRow) {
    const raw = (row.raw ?? {}) as MySubmissionRaw;
    const submitted = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });
    const detail =
      raw.promotionState && raw.promotionState !== "none" ? ` · promotion ${raw.promotionState}` : "";
    const reason = raw.decisionReason ? ` · ${raw.decisionReason}` : "";
    const right =
      row.status === "pending" ? (
        <MarketplaceDecisionActions sourceId={SOURCE_ID} rowId={row.id} mode="withdraw" />
      ) : (
        <Link
          href={MARKETPLACE_SUBMISSIONS_SELF_HREF}
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          Details
        </Link>
      );
    return (
      <MarketplaceRowView
        title={row.title}
        statusLabel={row.status}
        statusVariant={statusVariant(row.status)}
        meta={`submitted ${submitted}${detail}${reason}`}
        right={right}
      />
    );
  },

  actions: { decide: withdrawMarketplaceSubmission },
};
