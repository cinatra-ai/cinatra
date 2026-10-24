import type { StatusPillStatus } from "@/components/ui/status-pill";

import type { RowEligibility } from "./types";

// ---------------------------------------------------------------------------
// Marketplace approval state -> roster status pill (cinatra#4296).
//
// The application drawing's "Marketplace approval states" block (specs/app.html
// V.1) maps every state of a vendor application or an extension submission to
// one roster pill: "none rides on a Badge, and the pill's own label is shown,
// never the raw state word." Pure, so the four sources and their tests share
// one table.
// ---------------------------------------------------------------------------

export type MarketplaceStatePill = {
  status: StatusPillStatus;
  label: string;
  /** The two pending pills are drawn with a dot; every other state is icon-led. */
  glyph: "icon" | "dot";
};

export function marketplaceStatePill(
  state: string,
  { viewerMayDecide }: { viewerMayDecide: boolean },
): MarketplaceStatePill {
  switch (state) {
    case "applied":
    case "pending":
      return viewerMayDecide
        ? { status: "hold", label: "Awaiting you", glyph: "dot" }
        : { status: "idle", label: "Awaiting others", glyph: "dot" };
    case "approved":
    case "promoted":
      return { status: "approved", label: "Approved", glyph: "icon" };
    case "rejected":
      return { status: "declined", label: "Declined", glyph: "icon" };
    case "withdrawn":
    case "cancelled":
      return { status: "withdrawn", label: "Withdrawn", glyph: "icon" };
    case "reset":
      return { status: "reset", label: "Reset", glyph: "icon" };
    case "superseded":
      return { status: "archived", label: "Archived", glyph: "icon" };
    default:
      // A state the drawing does not name: a neutral pill that claims nothing,
      // never the raw state word.
      return { status: "idle", label: "Unknown", glyph: "icon" };
  }
}

/**
 * Whether the viewer may decide a moderation row. The marketplace's OPTIONAL
 * eligibility hint (#1045) refuses a decision with `false`; an absent hint
 * stays optimistic (action-time enforcement is authoritative). The row is
 * "awaiting others" only when BOTH decisions are refused.
 */
export function viewerMayDecide(eligibility: RowEligibility | undefined): boolean {
  if (!eligibility) return true;
  return !(eligibility.can_approve === false && eligibility.can_reject === false);
}
