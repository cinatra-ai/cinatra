"use client";

// ---------------------------------------------------------------------------
// /notifications v2 — approval row inline decide (cinatra#1557, E7).
//
// The trailing action slot of an ACTIONABLE approval row. It reuses the SAME
// per-source decision components the `/configuration/approvals` page uses — so
// the #1327 access-scope Approve dialog (agent), the host-port approve-only
// affordance, and the marketplace moderate (approve + reject) affordance are
// byte-identical, decided through the
// one shared `decideApprovalRow` server action + the source's non-redirecting
// `decide` helper. The `onDecided` callback removes the row from the client feed
// optimistically the moment the decision succeeds (§ decided-row-disappears),
// complementing E5's pending-only predicate (the row is also gone on next fetch).
// ---------------------------------------------------------------------------

import { AgentDecisionActions } from "@/app/configuration/approvals/agent-decision-actions";
import { HostPortGrantDecisionActions } from "@/app/configuration/approvals/host-port-grant-decision-actions";
import { PromotionDecisionActions } from "@/app/configuration/approvals/promotion-decision-actions";
import { MarketplaceDecisionActions } from "@/app/configuration/approvals/marketplace-decision-actions";

import type { ApprovalRowVM } from "./feed-view-model";

export function ApprovalInlineActions({
  approval,
  onDecided,
}: {
  approval: ApprovalRowVM;
  onDecided: () => void;
}): React.ReactElement | null {
  const { sourceId, rowId, decideKind, version, href, eligibility } = approval;

  switch (decideKind) {
    case "agent":
      return (
        <AgentDecisionActions
          sourceId={sourceId}
          rowId={rowId}
          expectedVersion={version ?? ""}
          detailsHref={href ?? "/notifications"}
          onDecided={onDecided}
        />
      );
    case "host-port":
      return (
        <HostPortGrantDecisionActions
          sourceId={sourceId}
          rowId={rowId}
          expectedVersion={version ?? ""}
          onDecided={onDecided}
        />
      );
    case "promotion":
      return (
        <PromotionDecisionActions
          sourceId={sourceId}
          rowId={rowId}
          expectedVersion={version ?? ""}
          onDecided={onDecided}
        />
      );
    case "marketplace-moderate":
      return (
        <MarketplaceDecisionActions
          sourceId={sourceId}
          rowId={rowId}
          mode="moderate"
          eligibility={eligibility}
          detailsHref={href}
          onDecided={onDecided}
        />
      );
    default:
      return null;
  }
}
