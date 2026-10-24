import type { ComponentProps } from "react";

import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";

// ---------------------------------------------------------------------------
// The pending pill of an approval and the repair-stuck flag (cinatra#4296).
//
// The application drawing's "Marketplace approval states" block (specs/app.html
// V.1) names the pending pill "the pending pill of the approval card, as drawn
// on Notifications; one pending state is drawn one way on every screen". This
// module is that one rendering: the Notifications approval card and the
// marketplace approval row both draw their pending pill from here.
//
//   Awaiting you    = `pill hold` with a dot (the viewer can decide the row)
//   Awaiting others = `pill idle` with a dot (someone else decides it)
//
// Repair stuck is "drawn as the existing Failed pill" beside the row's state
// pill, and "the row's meta line carries the attempt count".
//
// Pure and free of server-only and client-only code, so a server row renderer
// and the client feed import the same component.
// ---------------------------------------------------------------------------

export type PendingApprovalPill = {
  status: Extract<StatusPillStatus, "hold" | "idle">;
  label: "Awaiting you" | "Awaiting others";
  glyph: "dot";
};

const AWAITING_YOU: PendingApprovalPill = { status: "hold", label: "Awaiting you", glyph: "dot" };
const AWAITING_OTHERS: PendingApprovalPill = { status: "idle", label: "Awaiting others", glyph: "dot" };

/** The pending pill for a viewer who may (or may not) decide the approval. */
export function pendingApprovalPill(viewerMayDecide: boolean): PendingApprovalPill {
  return viewerMayDecide ? AWAITING_YOU : AWAITING_OTHERS;
}

type SpanProps = Omit<ComponentProps<"span">, "children" | "className">;

/** The one pending pill of an approval, as V.1 draws it. */
export function ApprovalPendingPill({
  viewerMayDecide,
  ...props
}: { viewerMayDecide: boolean } & SpanProps) {
  const pill = pendingApprovalPill(viewerMayDecide);
  return (
    <StatusPill status={pill.status} glyph={pill.glyph} {...props}>
      {pill.label}
    </StatusPill>
  );
}

/** Repair stuck: the existing Failed pill, drawn beside the state pill. */
export function RepairStuckPill() {
  return (
    <StatusPill status="failed" title="Repair stuck: an administrator must step in.">
      Failed
    </StatusPill>
  );
}

/**
 * The attempt count of a stuck repair, for the row's meta line. Empty when there
 * is no attempt to count.
 */
export function repairAttemptsText(attempts: number): string {
  const n = Math.floor(attempts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return `${n} repair ${n === 1 ? "attempt" : "attempts"}`;
}
