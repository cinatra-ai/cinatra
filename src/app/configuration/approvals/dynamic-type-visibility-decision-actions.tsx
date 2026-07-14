"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { decideApprovalRow, type InlineDecideState } from "./actions";

const INITIAL: InlineDecideState = { ok: false };

/**
 * Inline APPROVE affordance for a dynamic-type artifact-coverage row
 * (cinatra#1433). Approve-only by design: an unapproved dynamic type's rows
 * simply stay plain objects (fail-closed — no coverage is conveyed), so
 * "reject" is simply not deciding. Submits through the shared
 * `decideApprovalRow` server action — the SAME non-redirecting decide path the
 * `approvals_*` MCP tools use. No edit-after-view token: the decide re-checks
 * the type's live status and the existing-approval state at its source.
 */
export function DynamicTypeVisibilityDecisionActions({
  sourceId,
  rowId,
}: {
  sourceId: string;
  rowId: string;
}) {
  const [state, formAction, pending] = useActionState(decideApprovalRow, INITIAL);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <form action={formAction} className="flex items-center gap-2">
        <Input type="hidden" name="sourceId" value={sourceId} />
        <Input type="hidden" name="rowId" value={rowId} />
        <Input type="hidden" name="action" value="approve" />
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? "Approving…" : "Approve coverage"}
        </Button>
      </form>
      {!state.ok && state.error ? (
        <p className="max-w-64 text-right text-xs text-destructive">{state.error}</p>
      ) : null}
    </div>
  );
}
