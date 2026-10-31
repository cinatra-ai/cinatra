/**
 * The status cell of the two extension submissions tables (specs/app.html V.2).
 * An approved or promoted submission takes the Approved pill, and the promotion
 * step stands under it on a muted second line. Every other state draws its own
 * pill's label, never the raw state word (the marketplace approval states, V.1).
 *
 * NOTE: the `promotion_state` axis only matters when status='approved'. For
 * other statuses promotion_state is `none` and we ignore it.
 */

import { StatusPill } from "@/components/ui/status-pill";
import { ApprovalPendingPill } from "@/lib/approvals/approval-pills";
import { isPendingApprovalState, marketplaceStatePill } from "@/lib/approvals/sources/marketplace-state";

function promotionStep(status: string, promotionState: string): string | null {
  if (status === "promoted") return "Promoted";
  if (status !== "approved") return null;
  if (promotionState === "in_flight") return "Promotion in flight";
  if (promotionState === "failed") return "Promotion failed";
  if (promotionState === "complete") return "Promoted";
  return null;
}

export function SubmissionStatusPill({
  status,
  promotionState,
  promotionError,
  viewerMayDecide,
}: {
  status: string;
  promotionState: string;
  promotionError?: string | null;
  /** True on a row of the administrator's table the viewer may decide. The
   *  vendor's own table passes false: someone else decides its pending rows. */
  viewerMayDecide: boolean;
}) {
  const pill = marketplaceStatePill(status, { viewerMayDecide });
  const step = promotionStep(status, promotionState);
  return (
    <div title={promotionError ? `Error: ${promotionError}` : undefined}>
      {isPendingApprovalState(status) ? (
        <ApprovalPendingPill viewerMayDecide={viewerMayDecide} data-state={status} />
      ) : (
        <StatusPill status={pill.status} glyph={pill.glyph} data-state={status}>
          {pill.label}
        </StatusPill>
      )}
      {step ? <p className="mt-[3px] text-[11.5px] text-muted-foreground">{step}</p> : null}
    </div>
  );
}
