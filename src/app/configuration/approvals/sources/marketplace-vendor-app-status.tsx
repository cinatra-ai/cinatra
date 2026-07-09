import "server-only";

import { format } from "date-fns";
import Link from "next/link";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";

import { MarketplaceRowView, type MarketplaceBadgeVariant } from "./marketplace-row";
import {
  MARKETPLACE_GROUP,
  MARKETPLACE_VENDOR_APP_STATUS_HREF,
  MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID,
  guardedCount,
  guardedFetch,
  hasVendorToken,
  marketplaceAvailability,
  resolveVendorToken,
} from "./marketplace-shared";
import type { ApprovalRow, ApprovalSource, SourceCounts } from "./types";

// ---------------------------------------------------------------------------
// Marketplace source #4 — this instance's vendor-application STATUS ("Your
// requests" only).
//
// A READ-ONLY reflection of the instance's own commercial-tier vendor
// application awaiting marketplace moderation. Credential:
// `resolveConsumerOrVendorMarketplaceToken` (env override → consumer attachment
// → legacy vendor token) — mirrors the environment page's status refresh. The
// lifecycle mutations (apply / cancel) stay on the environment registries card;
// this section links there. `state === "none"` (no application) renders the
// standard Empty; a live row appears only when the instance has applied.
// ---------------------------------------------------------------------------

const SOURCE_ID = MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID;

interface StatusRaw {
  tier: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  repairStuck: boolean;
}

function statusVariant(state: string): MarketplaceBadgeVariant {
  switch (state) {
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

export const marketplaceVendorAppStatusSource: ApprovalSource = {
  id: SOURCE_ID,
  title: "This instance's vendor application",
  group: MARKETPLACE_GROUP,

  viewAllHref: (dir) => (dir === "mine" ? MARKETPLACE_VENDOR_APP_STATUS_HREF : undefined),

  availability: () => marketplaceAvailability(),

  appliesTo: (viewer, direction) => viewer.isAdmin && direction === "mine",

  sectionConfigured: () => hasVendorToken(),

  async fetchInbox() {
    return { availability: "ready", rows: [], actions: [] };
  },

  async fetchMine(viewer) {
    return guardedFetch(viewer, resolveVendorToken(), [], async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      const status = await client.vendorApplicationStatus();
      // "none" = no application row exists for this instance → empty section.
      if (status.state === "none") return [];
      const raw: StatusRaw = {
        tier: status.tier ?? null,
        decisionReason: status.decision_reason ?? null,
        decidedAt: status.decided_at ?? null,
        repairStuck: status.repair_stuck_at != null,
      };
      const row: ApprovalRow = {
        id: status.application_id ?? "vendor-application",
        sourceId: SOURCE_ID,
        title: status.scope ?? "Vendor application",
        status: status.state,
        createdAt: status.decided_at ?? "",
        raw,
      };
      return [row];
    });
  },

  async counts(viewer): Promise<SourceCounts> {
    // The instance's application is "in flight" only while `applied`.
    const mine = await guardedCount(viewer, resolveVendorToken(), `${SOURCE_ID}:mine`, async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      const status = await client.vendorApplicationStatus();
      return status.state === "applied" ? 1 : 0;
    });
    return { inbox: 0, mine };
  },

  rowRenderer(row: ApprovalRow) {
    const raw = (row.raw ?? {}) as StatusRaw;
    const tier = raw.tier ? `${raw.tier} tier` : null;
    const decided =
      raw.decidedAt && !Number.isNaN(Date.parse(raw.decidedAt))
        ? `decided ${format(new Date(raw.decidedAt), "MMM d, yyyy")}`
        : row.status === "applied"
          ? "awaiting marketplace review"
          : null;
    const reason = raw.decisionReason ? ` · ${raw.decisionReason}` : "";
    const metaParts = [tier, decided].filter(Boolean).join(" · ");
    return (
      <MarketplaceRowView
        title={row.title}
        statusLabel={row.status}
        statusVariant={statusVariant(row.status)}
        meta={`${metaParts}${reason}` || "Vendor application"}
        right={
          <Link
            href={MARKETPLACE_VENDOR_APP_STATUS_HREF}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Manage
          </Link>
        }
      />
    );
  },

  actions: {
    // Read-only in the inbox — lifecycle mutations live on the environment card.
    async decide() {
      return {
        ok: false,
        kind: "refused",
        code: "not_supported",
        message: "Manage your vendor application from Environment → Registries.",
      };
    },
  },
};
