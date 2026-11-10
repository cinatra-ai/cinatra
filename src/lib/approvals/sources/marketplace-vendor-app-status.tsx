import "server-only";

import { format } from "date-fns";
import Link from "next/link";

import { createHttpMarketplaceMcpClient } from "@cinatra-ai/marketplace-mcp-client/http-client";
import type { MarketplaceVendorApplicationStatusOutput } from "@cinatra-ai/marketplace-mcp-client";

import { textField, toRepairStuck } from "../repair-stuck";
import { MarketplaceRowView } from "./marketplace-row";
import { marketplaceVendorAppStatusContract } from "./marketplace-vendor-app-status.contract";
import {
  MARKETPLACE_GROUP,
  MARKETPLACE_VENDOR_APP_STATUS_HREF,
  MARKETPLACE_VENDOR_APP_STATUS_SOURCE_ID,
  guardedFetch,
  hasVendorToken,
  isRegisteredVendor,
  resolveOwnVendorApplicationCreatedAt,
  resolveVendorToken,
} from "./marketplace-shared";
import type { ApprovalRow, ApprovalSource } from "./types";

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

// Every field below is read from the marketplace's unchecked JSON through
// ../repair-stuck: a text field that is not a non-empty string is null and is
// not drawn (cinatra#4296).
interface StatusRaw {
  tier: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
}

/**
 * The instance's own pending application as an approval row, or null when it is
 * not pending. Exported for its unit test (cinatra#4296).
 *
 * Repair stuck is published on the PUBLIC `repairStuck` field, so the row, the
 * Notifications card and every other renderer draw the Failed pill. The status
 * API carries the stuck stamp but no attempt count, so the field is `{}`: the
 * flag stands without a count. Stuck only for a valid `repair_stuck_at`
 * timestamp; missing, null, empty, invalid or a non-string is not stuck.
 */
export function toVendorApplicationStatusRow(
  status: MarketplaceVendorApplicationStatusOutput,
  createdAt: string,
): ApprovalRow | null {
  // Pending-only (E5 #1555): the unified feed surfaces the instance's own
  // vendor application only while it is in flight. `applied` is the sole
  // pending state; a decided/terminal application (approved / rejected) and
  // the "none" (no-row) sentinel leave the list — matching the contract's
  // `counts()`, which already counts only `state === "applied"`.
  if (status.state !== "applied") return null;
  const repairStuck = toRepairStuck(status.repair_stuck_at);
  const raw: StatusRaw = {
    tier: textField(status.tier),
    decisionReason: textField(status.decision_reason),
    decidedAt: textField(status.decided_at),
  };
  return {
    id: textField(status.application_id) ?? "vendor-application",
    sourceId: SOURCE_ID,
    title: textField(status.scope) ?? "Vendor application",
    status: status.state,
    // A REAL, sortable createdAt for the chronological merge (E5 #1555),
    // resolved from LOCAL durable state — the SAME value the moderator-queue
    // mirror emits for this instance's own application, so the deduped feed
    // row's keyset paging key is stable regardless of which mirror fetched it
    // (the old bug shipped `createdAt: ""`, unsortable).
    createdAt,
    ...(repairStuck ? { repairStuck } : {}),
    raw,
  };
}

export const marketplaceVendorAppStatusSource: ApprovalSource = {
  // Light nav contract (id / availability / appliesTo / counts) — the SAME
  // function references the nav registry consumes (registry-parity.test.ts).
  ...marketplaceVendorAppStatusContract,
  title: "This instance's vendor application",
  group: MARKETPLACE_GROUP,

  viewAllHref: (dir) => (dir === "mine" ? MARKETPLACE_VENDOR_APP_STATUS_HREF : undefined),

  // BOTH the credential gate AND the strict vendor-registration gate must hold —
  // a consumer attachment resolves a vendor token but is NOT a registered vendor
  // (owner ruling: no vendor info unless the instance is a registered vendor).
  sectionConfigured: () => hasVendorToken() && isRegisteredVendor(),

  async fetchInbox() {
    return { availability: "ready", rows: [], actions: [] };
  },

  async fetchMine(viewer) {
    // Gate ROW production on the registration predicate too — the `approvals_*`
    // MCP tools federate over this source without consulting `sectionConfigured`,
    // so a non-registered instance must resolve to `not_configured` here (no
    // remote call, zero rows) on EVERY consumer of the source, not just the page.
    const sectionToken = isRegisteredVendor() ? resolveVendorToken() : undefined;
    return guardedFetch(viewer, sectionToken, [], async (token) => {
      const client = createHttpMarketplaceMcpClient({ token });
      const status = await client.vendorApplicationStatus();
      const row = toVendorApplicationStatusRow(status, resolveOwnVendorApplicationCreatedAt());
      return row ? [row] : [];
    });
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
        state={row.status}
        // The instance's own stuck application keeps the Failed pill beside
        // its Awaiting others pill (specs/app.html V.1); the status API has no
        // attempt count, so the meta line names none.
        repairStuck={row.repairStuck !== undefined}
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
