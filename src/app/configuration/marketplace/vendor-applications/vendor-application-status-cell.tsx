import { StatusPill } from "@/components/ui/status-pill";
import { ApprovalPendingPill, RepairStuckPill } from "@/lib/approvals/approval-pills";
import { repairAttemptCount } from "@/lib/approvals/repair-stuck";
import { isPendingApprovalState, marketplaceStatePill } from "@/lib/approvals/sources/marketplace-state";

// The status cell of the vendor applications table (specs/app.html V.2): the
// state pill's own label, never the raw state word. Repair stuck puts the Failed
// pill beside the state pill, and the attempt count stands beside the Failed
// pill. A count that is zero or malformed is not drawn (../../../../lib/approvals/repair-stuck).
export function VendorApplicationStatusCell({
  status,
  viewerMayDecide,
  repairStuckAt,
  attempts,
}: {
  status: string;
  viewerMayDecide: boolean;
  repairStuckAt: string | null;
  attempts: unknown;
}) {
  const pill = marketplaceStatePill(status, { viewerMayDecide });
  const count = repairStuckAt ? repairAttemptCount(attempts) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {isPendingApprovalState(status) ? (
        <ApprovalPendingPill viewerMayDecide={viewerMayDecide} data-state={status} />
      ) : (
        <StatusPill status={pill.status} glyph={pill.glyph} data-state={status}>
          {pill.label}
        </StatusPill>
      )}
      {repairStuckAt ? <RepairStuckPill /> : null}
      {count ? (
        <span className="text-[11.5px] text-muted-foreground">
          {count} {count === 1 ? "attempt" : "attempts"}
        </span>
      ) : null}
    </div>
  );
}
