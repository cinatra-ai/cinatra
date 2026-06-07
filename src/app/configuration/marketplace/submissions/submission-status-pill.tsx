/**
 * Maps the marketplace's `(status, promotion_state)` two-axis state to the
 * design-system StatusPill.
 *
 *   pending                  → queued      "Pending review"
 *   approved + in_flight     → running     "Promotion in flight"
 *   approved + failed        → needs-review (mustard) "Promotion failed"
 *   promoted + complete      → approved (green) "Promoted"
 *   rejected                 → declined    "Rejected"
 *   withdrawn                → archived    "Withdrawn"
 *   superseded               → archived    "Superseded"
 *   (anything else)          → idle        with the raw status text
 *
 * NOTE: the `promotion_state` axis only matters when status='approved'. For
 * other statuses promotion_state is `none` and we ignore it.
 */

import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";

function pickStatus(
  status: string,
  promotionState: string,
): { pill: StatusPillStatus; label: string } {
  if (status === "approved") {
    if (promotionState === "in_flight") return { pill: "running", label: "Promotion in flight" };
    if (promotionState === "failed")    return { pill: "needs-review", label: "Promotion failed" };
    if (promotionState === "complete")  return { pill: "approved", label: "Promoted" };
    return { pill: "approved", label: "Approved" };
  }
  if (status === "promoted")  return { pill: "approved", label: "Promoted" };
  if (status === "pending")   return { pill: "queued", label: "Pending review" };
  if (status === "rejected")  return { pill: "declined", label: "Rejected" };
  if (status === "withdrawn") return { pill: "archived", label: "Withdrawn" };
  if (status === "superseded") return { pill: "archived", label: "Superseded" };
  return { pill: "idle", label: status };
}

export function SubmissionStatusPill({
  status,
  promotionState,
  promotionError,
}: {
  status: string;
  promotionState: string;
  promotionError?: string | null;
}) {
  const { pill, label } = pickStatus(status, promotionState);
  return (
    <span
      className="inline-flex items-center gap-2"
      title={promotionError ? `Error: ${promotionError}` : undefined}
    >
      <StatusPill status={pill}>{label}</StatusPill>
    </span>
  );
}
