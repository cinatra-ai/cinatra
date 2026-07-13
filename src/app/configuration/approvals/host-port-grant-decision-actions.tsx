"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { decideApprovalRow, type InlineDecideState } from "./actions";

const INITIAL: InlineDecideState = { ok: false };

/**
 * Inline APPROVE affordance for a host-port grant review row (cinatra#1391).
 * Approve-only by design: an unapproved grant stays `pending` (fail-closed —
 * no port is conveyed), so "reject" is simply not deciding; withdrawing the
 * request means uninstalling the declaring version. Submits through the shared
 * `decideApprovalRow` server action — the SAME non-redirecting decide path the
 * `approvals_*` MCP tools use. `expectedVersion` carries the request-hash
 * token captured at render (edit-after-view guard); a stale decide surfaces
 * the structured refusal in place.
 */
export function HostPortGrantDecisionActions({
  sourceId,
  rowId,
  expectedVersion,
}: {
  sourceId: string;
  rowId: string;
  expectedVersion: string;
}) {
  const [state, formAction, pending] = useActionState(decideApprovalRow, INITIAL);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <form action={formAction} className="flex items-center gap-2">
        <Input type="hidden" name="sourceId" value={sourceId} />
        <Input type="hidden" name="rowId" value={rowId} />
        <Input type="hidden" name="action" value="approve" />
        <Input type="hidden" name="expectedVersion" value={expectedVersion} />
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? "Approving…" : "Approve ports"}
        </Button>
      </form>
      {!state.ok && state.error ? (
        <p className="max-w-64 text-right text-xs text-destructive">{state.error}</p>
      ) : null}
    </div>
  );
}
