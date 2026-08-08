import "server-only";

import { formatDistanceToNow } from "date-fns";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type { MarketplaceVendorApplicationAdminRow } from "@cinatra-ai/marketplace-mcp-client";

import { Badge } from "@/components/ui/badge";

import { MarketplaceDecisionActions } from "../marketplace-decision-actions";
import { decideMarketplaceVendorApplication } from "../marketplace-decision-helpers";
import { MarketplaceRowView, type MarketplaceBadgeVariant } from "./marketplace-row";
import { marketplaceVendorAppModerationContract } from "./marketplace-vendor-app-moderation.contract";
import {
  MARKETPLACE_GROUP,
  MARKETPLACE_VENDOR_APPS_ADMIN_HREF,
  MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID,
  guardedFetch,
  hasAdminToken,
  isRegisteredVendor,
  resolveAdminToken,
  resolveOwnVendorApplicationCreatedAt,
  resolveOwnVendorApplicationId,
  toRowEligibility,
} from "./marketplace-shared";
import type { ApprovalAction, ApprovalRow, ApprovalSource } from "./types";

// ---------------------------------------------------------------------------
// Marketplace source #2 — vendor-application MODERATION (Inbox only).
//
// The moderator queue of commercial-tier vendor applications awaiting review.
// Credential: `resolveMarketplaceAdminToken()` (`MARKETPLACE_ADMIN_TOKEN`) —
// mirrors the drill-down vendor-applications page. Free-tier applications
// auto-approve inline and never appear here. Approve / Reject decide through the
// non-redirecting helper; the marketplace WP cap is the authoritative gate.
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_VENDOR_APP_MODERATION_SOURCE_ID;
// Per-request page size for the cursor-paginated drain (the marketplace caps a
// single vendor_application_list_admin call at this many rows and returns a
// `next_cursor` for the rest — see MAX_PAGES).
const PAGE_LIMIT = 50;
// Safety bound on the pagination drain so a runaway `next_cursor` (a
// misbehaving marketplace that never returns null) can never loop unbounded.
// PAGE_LIMIT * MAX_PAGES = 2000 pending applications is far beyond any real
// moderation backlog; the queue is expected to be small.
const MAX_PAGES = 40;

const MODERATE_ACTIONS: ApprovalAction[] = [
  { id: "approve", label: "Approve", enforcement: "action-time" },
  { id: "reject", label: "Reject", intent: "destructive", enforcement: "action-time", requiresReason: true },
];

interface VendorAppRaw {
  scope: string;
  tier: string;
  repairStuck: boolean;
  recoveryAttempts: number;
}

function statusVariant(status: string): MarketplaceBadgeVariant {
  switch (status) {
    case "approved":
      return "default";
    case "rejected":
      return "destructive";
    case "applied":
      return "secondary";
    default:
      return "outline";
  }
}

// `ownAppId` / `ownCreatedAt` align the ONE row that is this instance's own
// application (also visible via the self-status mirror) onto the SAME local
// timestamp both adapters resolve, so the unified feed's deduped keyset cursor
// is stable no matter which mirror fetched it (cinatra#1555). Every OTHER
// vendor's row keeps the authoritative remote `applied_at`.
function toRow(
  r: MarketplaceVendorApplicationAdminRow,
  ownAppId: string | undefined,
  ownCreatedAt: string,
): ApprovalRow {
  const raw: VendorAppRaw = {
    scope: r.scope,
    tier: r.tier,
    repairStuck: r.repair_stuck_at !== null,
    recoveryAttempts: r.recovery_attempts,
  };
  return {
    id: r.application_id,
    sourceId: SOURCE_ID,
    title: r.display_name,
    subtitle: r.scope,
    status: r.status,
    createdAt: ownAppId && r.application_id === ownAppId ? ownCreatedAt : r.applied_at,
    eligibility: toRowEligibility(r.eligibility),
    raw,
  };
}

export const marketplaceVendorAppModerationSource: ApprovalSource = {
  // Light nav contract (id / availability / appliesTo / counts) — the SAME
  // function references the nav registry consumes (registry-parity.test.ts).
  ...marketplaceVendorAppModerationContract,
  title: "Vendor applications",
  group: MARKETPLACE_GROUP,

  viewAllHref: (dir) => (dir === "inbox" ? MARKETPLACE_VENDOR_APPS_ADMIN_HREF : undefined),

  // Per-direction credential gate — its own `MARKETPLACE_ADMIN_TOKEN` — AND the
  // strict vendor-registration gate. Closes the issue's stated bug that vendor-
  // app moderation was "additionally gated only on the admin token": an admin-
  // token instance that is not itself a registered vendor sees no vendor rows.
  sectionConfigured: () => hasAdminToken() && isRegisteredVendor(),

  async fetchInbox(viewer) {
    // Gate ROW production on the registration predicate too — the `approvals_*`
    // MCP tools reach this fetch without consulting `sectionConfigured`, so a
    // non-registered instance resolves to `not_configured` (no remote call, zero
    // rows) on every consumer of the source, not just the page.
    const sectionToken = isRegisteredVendor() ? resolveAdminToken() : undefined;
    return guardedFetch(viewer, sectionToken, MODERATE_ACTIONS, async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      // Drain the cursor (E5 #1555): the endpoint returns at most PAGE_LIMIT rows
      // per call plus a `next_cursor` for the remainder. The prior single call
      // silently truncated the moderation queue at 50; follow `next_cursor` until
      // it is null (bounded by MAX_PAGES) so the unified feed sees every pending
      // application, not just the newest page.
      const rows: MarketplaceVendorApplicationAdminRow[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const out = await client.vendorApplicationListAdmin({
          status: ["applied"],
          limit: PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
        });
        rows.push(...out.rows);
        if (!out.next_cursor) break;
        cursor = out.next_cursor;
      }
      // Resolve the instance's own application identity ONCE (local, no network)
      // so its row aligns with the self-status mirror's timestamp.
      const ownAppId = resolveOwnVendorApplicationId();
      const ownCreatedAt = resolveOwnVendorApplicationCreatedAt();
      return rows.map((r) => toRow(r, ownAppId, ownCreatedAt));
    });
  },

  async fetchMine() {
    // Inbox-only source; the instance's own status is the vendor-app-status source.
    return { availability: "ready", rows: [], actions: [] };
  },

  rowRenderer(row: ApprovalRow) {
    const raw = (row.raw ?? {}) as VendorAppRaw;
    const applied = formatDistanceToNow(new Date(row.createdAt), { addSuffix: true });
    return (
      <MarketplaceRowView
        title={row.title}
        statusLabel={row.status}
        statusVariant={statusVariant(row.status)}
        extraBadges={
          <>
            <Badge variant="outline" className="font-mono text-xs">
              {raw.scope}
            </Badge>
            {raw.repairStuck ? (
              <Badge variant="destructive" className="text-xs">
                {raw.recoveryAttempts > 0 ? `repair stuck · ${raw.recoveryAttempts}` : "repair stuck"}
              </Badge>
            ) : null}
          </>
        }
        meta={`${raw.tier} tier · applied ${applied}`}
        right={
          <MarketplaceDecisionActions
            sourceId={SOURCE_ID}
            rowId={row.id}
            mode="moderate"
            eligibility={row.eligibility}
            detailsHref={MARKETPLACE_VENDOR_APPS_ADMIN_HREF}
          />
        }
      />
    );
  },

  actions: { decide: decideMarketplaceVendorApplication },
};
