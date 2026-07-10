"use client";

import { useActionState, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { decideApprovalRow, type InlineDecideState } from "./actions";

const INITIAL: InlineDecideState = { ok: false };

/**
 * Inline Approve / Reject affordance for an agent-creation-request row — used on
 * an Inbox row (a request someone else must decide) and, for a pending own
 * request the viewer may clear themselves, on its "Your requests" row. Submits
 * through the shared `decideApprovalRow` server action (which dispatches to the
 * source's non-redirecting `decide` helper), carrying the CAS token
 * (`expectedVersion`) captured at render so an edit-after-view is still caught.
 * Reject reveals a required reason. A business refusal — including a
 * separation-of-duties refusal — is surfaced in place.
 */
export function AgentDecisionActions({
  sourceId,
  rowId,
  expectedVersion,
  detailsHref,
}: {
  sourceId: string;
  rowId: string;
  expectedVersion: string;
  detailsHref: string;
}) {
  const [state, formAction, pending] = useActionState(decideApprovalRow, INITIAL);
  const [rejecting, setRejecting] = useState(false);

  const hidden = (
    <>
      <Input type="hidden" name="sourceId" value={sourceId} />
      <Input type="hidden" name="rowId" value={rowId} />
      <Input type="hidden" name="expectedVersion" value={expectedVersion} />
    </>
  );

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
            <Button type="submit" size="sm" variant="destructive" disabled={pending}>
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
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Working…" : "Approve"}
            </Button>
          </form>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setRejecting(true)}
          >
            Reject
          </Button>
          <Link
            href={detailsHref}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Details
          </Link>
        </div>
      )}

      {!state.ok && state.error ? (
        <p className="max-w-56 text-right text-xs text-destructive">{state.error}</p>
      ) : null}
    </div>
  );
}
