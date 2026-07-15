"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { decideApprovalRow, type InlineDecideState } from "./actions";
import type { RowEligibility } from "./sources/types";

const INITIAL: InlineDecideState = { ok: false };

/**
 * Inline decision affordance for a marketplace approval row. Submits through the
 * shared `decideApprovalRow` server action (#1044), which dispatches to the
 * source's non-redirecting decide helper — the SAME path the future MCP tools
 * reuse. A business refusal (SoD / not-authorized / gone) is surfaced in place
 * with the readable #1046 message.
 *
 *   mode="moderate" — Approve + Reject (Reject reveals a required reason).
 *   mode="withdraw" — Withdraw the instance's own pending submission.
 *
 * OPTIONAL row eligibility (#1045): when the marketplace supplies `can_approve` /
 * `can_reject` / `reason`, the matching button is disabled and annotated;
 * action-time enforcement at the marketplace stays authoritative regardless.
 */
export function MarketplaceDecisionActions({
  sourceId,
  rowId,
  mode,
  eligibility,
  detailsHref,
  onDecided,
}: {
  sourceId: string;
  rowId: string;
  mode: "moderate" | "withdraw";
  eligibility?: RowEligibility;
  detailsHref?: string;
  /** OPTIONAL — fired once when the decision succeeds (E7 feed optimistic drop). */
  onDecided?: () => void;
}) {
  const [state, formAction, pending] = useActionState(decideApprovalRow, INITIAL);
  const [rejecting, setRejecting] = useState(false);
  const decidedRef = useRef(false);
  useEffect(() => {
    if (state.ok && !decidedRef.current) {
      decidedRef.current = true;
      onDecided?.();
    }
  }, [state.ok, onDecided]);

  const hidden = (
    <>
      <Input type="hidden" name="sourceId" value={sourceId} />
      <Input type="hidden" name="rowId" value={rowId} />
    </>
  );

  const errorText =
    !state.ok && state.error ? (
      <p className="max-w-64 text-right text-xs text-destructive">{state.error}</p>
    ) : null;

  if (mode === "withdraw") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <form action={formAction}>
          {hidden}
          <Input type="hidden" name="action" value="withdraw" />
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "Withdrawing…" : "Withdraw"}
          </Button>
        </form>
        {errorText}
      </div>
    );
  }

  // moderate
  const approveDisabled = pending || eligibility?.can_approve === false;
  const rejectDisabled = pending || eligibility?.can_reject === false;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {rejecting ? (
        <form action={formAction} className="flex w-56 flex-col gap-2">
          {hidden}
          <Input type="hidden" name="action" value="reject" />
          <Textarea
            name="reason"
            required
            rows={2}
            placeholder="Reason for rejection"
            className="text-xs"
            aria-label="Reason for rejection"
          />
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" variant="destructive" disabled={rejectDisabled}>
              {pending ? "Rejecting…" : "Confirm rejection"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setRejecting(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <form action={formAction}>
            {hidden}
            <Input type="hidden" name="action" value="approve" />
            <Button
              type="submit"
              size="sm"
              disabled={approveDisabled}
              title={eligibility?.can_approve === false ? eligibility?.reason : undefined}
            >
              {pending ? "Working…" : "Approve"}
            </Button>
          </form>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={rejectDisabled}
            title={eligibility?.can_reject === false ? eligibility?.reason : undefined}
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
          {detailsHref ? (
            <Link
              href={detailsHref}
              className="text-xs text-muted-foreground underline hover:text-foreground"
            >
              Details
            </Link>
          ) : null}
        </div>
      )}

      {eligibility?.reason &&
      (eligibility.can_approve === false || eligibility.can_reject === false) ? (
        <p className="max-w-64 text-right text-xs text-muted-foreground">{eligibility.reason}</p>
      ) : null}

      {errorText}
    </div>
  );
}
