"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { decideApprovalRow, type InlineDecideState } from "./actions";

const INITIAL: InlineDecideState = { ok: false };

/**
 * Inline APPROVE / REJECT affordance for a shared-promotion review row
 * (cinatra#1560). Generic across every subject type (memory #1381, artifact
 * #1437, …): the subject rides the `rowId` prefix, so ONE component serves them
 * all. Submits through the shared `decideApprovalRow` server action — the SAME
 * non-redirecting decide path the `approvals_*` MCP tools use — which routes to
 * the subject's backend by that prefix. `expectedVersion` carries the CAS token
 * captured at render (the edit-after-view guard); a stale/narrowing/secret-scan
 * refusal surfaces the structured message in place. Reject requires a reason.
 */
export function PromotionDecisionActions({
  sourceId,
  rowId,
  expectedVersion,
  onDecided,
}: {
  sourceId: string;
  rowId: string;
  /** CAS token from the reviewed row (`ApprovalRow.version`); "" when absent. */
  expectedVersion: string;
  /** OPTIONAL — fired once when a decision succeeds (E7 feed optimistic drop). */
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

  return (
    <div className="flex flex-col items-end gap-1.5">
      {rejecting ? (
        <form action={formAction} className="flex items-center gap-2">
          <Input type="hidden" name="sourceId" value={sourceId} />
          <Input type="hidden" name="rowId" value={rowId} />
          <Input type="hidden" name="action" value="reject" />
          <Input type="hidden" name="expectedVersion" value={expectedVersion} />
          <Input
            name="reason"
            required
            placeholder="Reason for rejection"
            className="h-8 w-52 text-sm"
            aria-label="Reason for rejection"
          />
          <Button size="sm" type="submit" variant="destructive" disabled={pending}>
            {pending ? "Rejecting…" : "Confirm reject"}
          </Button>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => setRejecting(false)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <form action={formAction}>
            <Input type="hidden" name="sourceId" value={sourceId} />
            <Input type="hidden" name="rowId" value={rowId} />
            <Input type="hidden" name="action" value="approve" />
            <Input type="hidden" name="expectedVersion" value={expectedVersion} />
            <Button size="sm" type="submit" disabled={pending}>
              {pending ? "Approving…" : "Approve"}
            </Button>
          </form>
          <Button
            size="sm"
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
        </div>
      )}
      {!state.ok && state.error ? (
        <p className="max-w-64 text-right text-xs text-destructive">{state.error}</p>
      ) : null}
    </div>
  );
}
