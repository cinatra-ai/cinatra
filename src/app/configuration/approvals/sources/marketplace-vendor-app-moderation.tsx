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
const LIST_LIMIT = 50;

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

function toRow(r: MarketplaceVendorApplicationAdminRow): ApprovalRow {
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
    createdAt: r.applied_at,
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
      const out = await client.vendorApplicationListAdmin({ status: ["applied"], limit: LIST_LIMIT });
      return out.rows.map(toRow);
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
