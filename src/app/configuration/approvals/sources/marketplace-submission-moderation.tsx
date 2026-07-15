import "server-only";

import { formatDistanceToNow } from "date-fns";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type { MarketplaceAdminSubmission } from "@cinatra-ai/marketplace-mcp-client";

import { MarketplaceDecisionActions } from "../marketplace-decision-actions";
import { decideMarketplaceSubmission } from "../marketplace-decision-helpers";
import { MarketplaceRowView, type MarketplaceBadgeVariant } from "./marketplace-row";
import { marketplaceSubmissionModerationContract } from "./marketplace-submission-moderation.contract";
import {
  MARKETPLACE_GROUP,
  MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID,
  MARKETPLACE_SUBMISSIONS_ADMIN_HREF,
  guardedFetch,
  hasAdminToken,
  isRegisteredVendor,
  resolveAdminToken,
  toRowEligibility,
} from "./marketplace-shared";
import type { ApprovalAction, ApprovalRow, ApprovalSource } from "./types";

// ---------------------------------------------------------------------------
// Marketplace source #1 — extension-submission MODERATION (Inbox only).
//
// The moderator queue of all vendors' pending extension submissions. Credential:
// `MARKETPLACE_ADMIN_TOKEN` via `resolveMarketplaceAdminToken()` (#1224 — the
// list-admin/approve/reject abilities are `PRINCIPAL_ADMIN`-bound, so they use
// the ADMIN credential, exactly like vendor-application moderation; the section
// is `not_configured` (hidden + footer hint) when the admin token is absent).
// Approve / Reject decide at the marketplace through the non-redirecting helper;
// the marketplace's WP cap + separation-of-duties are the authoritative gate and
// surface as readable #1046 text at action time.
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_SUBMISSION_MODERATION_SOURCE_ID;
// Per-request page size for the offset-paginated drain. Unlike vendor-app
// moderation, `extension_submission_list_admin` exposes only `offset` (no
// cursor) and its output carries no `next_cursor`/`total` signal, so "more
// remain" is inferred structurally: a FULL page (=== PAGE_LIMIT) may have more
// behind it; a SHORT page is the end. (E5 #1555 decision: paginate via offset —
// the alternative of documenting the cap in-surface was not taken.)
const PAGE_LIMIT = 200;
// Safety bound on the offset drain so a marketplace that always returns a full
// page can never loop unbounded. PAGE_LIMIT * MAX_PAGES = 4000 pending
// submissions is far beyond any real moderation backlog.
const MAX_PAGES = 20;

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

// `showVendorCopy` gates the vendor-identifying `vendor #N` copy behind the
// strict vendor-registration predicate (owner ruling: no vendor info unless the
// instance is a registered vendor). Row PRODUCTION is unaffected — this is the
// extension-submission queue, not one of the two vendor-app sources — only the
// vendor-labelled `subtitle` (which flows to the `approvals_*` MCP tools via
// `toPublicRow`) is redacted.
function toRow(s: MarketplaceAdminSubmission, showVendorCopy: boolean): ApprovalRow {
  const raw: SubmissionRaw = { vendorId: s.vendor_id, promotionState: s.promotion_state };
  return {
    id: s.submission_id,
    sourceId: SOURCE_ID,
    title: s.target_final_identity,
    ...(showVendorCopy ? { subtitle: `vendor #${s.vendor_id}` } : {}),
    status: s.status,
    createdAt: s.submitted_at,
    eligibility: toRowEligibility(s.eligibility),
    raw,
  };
}

export const marketplaceSubmissionModerationSource: ApprovalSource = {
  // Light nav contract (id / availability / appliesTo / counts) — the SAME
  // function references the nav registry consumes, so the sidebar badge and this
  // page can never disagree (registry-parity.test.ts).
  ...marketplaceSubmissionModerationContract,
  title: "Extension submissions",
  group: MARKETPLACE_GROUP,

  viewAllHref: (dir) => (dir === "inbox" ? MARKETPLACE_SUBMISSIONS_ADMIN_HREF : undefined),

  // Per-direction credential gate — its own `MARKETPLACE_ADMIN_TOKEN` (#1224).
  sectionConfigured: () => hasAdminToken(),

  async fetchInbox(viewer) {
    // The vendor-identifying `vendor #N` copy is gated on the registration
    // predicate; the rows themselves still render (admin moderation is unchanged).
    const showVendorCopy = isRegisteredVendor();
    return guardedFetch(viewer, resolveAdminToken(), MODERATE_ACTIONS, async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      // Offset-paginated drain (E5 #1555): the prior single call silently
      // truncated the moderation queue at 200. Walk `offset` a page at a time
      // and stop on the first SHORT page (fewer than PAGE_LIMIT rows ⇒ no more
      // behind it), bounded by MAX_PAGES, so the unified feed sees every pending
      // submission.
      const submissions: MarketplaceAdminSubmission[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const out = await client.extensionSubmissionListAdmin({
          status: "pending",
          limit: PAGE_LIMIT,
          offset: page * PAGE_LIMIT,
        });
        submissions.push(...out.submissions);
        if (out.submissions.length < PAGE_LIMIT) break;
      }
      return submissions.map((s) => toRow(s, showVendorCopy));
    });
  },

  async fetchMine() {
    // Inbox-only source; "Your requests" is served by the my-submissions source.
    return { availability: "ready", rows: [], actions: [] };
  },

  rowRenderer(row: ApprovalRow) {
    const raw = (row.raw ?? {}) as SubmissionRaw;
    const submitted = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });
    const promo =
      raw.promotionState && raw.promotionState !== "none" ? ` · promotion ${raw.promotionState}` : "";
    // Suppress the vendor-identifying `vendor #N` prefix unless this instance is
    // a registered vendor (owner ruling); the submission itself still renders.
    const submittedMeta = `submitted ${submitted}${promo}`;
    const meta = isRegisteredVendor() ? `vendor #${raw.vendorId} · ${submittedMeta}` : submittedMeta;
    return (
      <MarketplaceRowView
        title={row.title}
        statusLabel={row.status}
        statusVariant={statusVariant(row.status)}
        meta={meta}
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
