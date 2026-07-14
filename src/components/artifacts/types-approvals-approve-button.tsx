"use client";

import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  approveDynamicTypeVisibilityFormAction,
  type ApproveVisibilityState,
} from "./types-approvals-approve-action";

const INITIAL: ApproveVisibilityState = { ok: false };

/**
 * §V Approve affordance for a proposed dynamic type. Approve-only by design: an
 * unapproved type's rows simply stay plain objects (fail-closed). Submits
 * through the shared server action, which writes the real org-scoped approval
 * record (#1433) and surfaces a business refusal inline.
 */
export function TypesApprovalsApproveButton({
  objectTypeId,
}: {
  objectTypeId: string;
}) {
  const [state, formAction, pending] = useActionState(
    approveDynamicTypeVisibilityFormAction,
    INITIAL,
  );
  return (
    <div className="flex flex-col items-end gap-1.5">
      <form action={formAction}>
        <Input type="hidden" name="objectTypeId" value={objectTypeId} />
        <Button
          type="submit"
          size="sm"
          disabled={pending}
          data-action="approve-type -> approved"
        >
          {pending ? "Approving…" : "Approve"}
        </Button>
      </form>
      {!state.ok && state.error ? (
        <p className="max-w-64 text-right text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}
