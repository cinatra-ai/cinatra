"use client";

/**
 * Approve / Reject / Retry-promotion buttons for the admin moderator queue.
 * Each is a button → Dialog → form posting the appropriate Server Action.
 *
 * Reject uses a Textarea + non-empty client-side gate; server-side action
 * also rejects empty strings.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import {
  approveSubmissionAction,
  rejectSubmissionAction,
  retryPromotionAction,
} from "../actions";

/** Mirrors REJECT_REASON_MAX in actions.ts — keep both in sync. */
const REJECT_REASON_MAX = 2000;

export function ApproveButton({
  submissionId,
  targetIdentity,
  returnStatus,
}: {
  submissionId: string;
  targetIdentity: string;
  returnStatus: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Approve</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve submission?</DialogTitle>
          <DialogDescription>
            This starts the promotion saga for{" "}
            <span className="font-mono">{targetIdentity}</span>. The
            marketplace publishes the staged tarball to the public scope and
            verifies the digest. Failures stay at{" "}
            <span className="font-mono">approved + failed</span> for retry —
            the approval is never silently reverted.
          </DialogDescription>
        </DialogHeader>
        <form action={approveSubmissionAction}>
          <Input type="hidden" name="submission_id" value={submissionId} />
          <Input type="hidden" name="return_status" value={returnStatus} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">Approve</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RejectButton({
  submissionId,
  targetIdentity,
  returnStatus,
}: {
  submissionId: string;
  targetIdentity: string;
  returnStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const isReasonValid =
    reason.trim().length > 0 && reason.length <= REJECT_REASON_MAX;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReason("");
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Reject
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject submission</DialogTitle>
          <DialogDescription>
            Rejecting{" "}
            <span className="font-mono">{targetIdentity}</span> requires a
            reason. The vendor sees this in their submissions list.
          </DialogDescription>
        </DialogHeader>
        <form action={rejectSubmissionAction}>
          <Input type="hidden" name="submission_id" value={submissionId} />
          <Input type="hidden" name="return_status" value={returnStatus} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="reject-reason">Reason</FieldLabel>
              <Textarea
                id="reject-reason"
                name="reason"
                rows={4}
                maxLength={REJECT_REASON_MAX}
                placeholder="Required — e.g. missing license headers, security policy violation, etc."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                required
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={!isReasonValid}>
              Reject
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RetryPromotionButton({
  submissionId,
  targetIdentity,
  promotionError,
  returnStatus,
}: {
  submissionId: string;
  targetIdentity: string;
  promotionError: string | null;
  returnStatus: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Retry promotion
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Retry promotion saga?</DialogTitle>
          <DialogDescription>
            Re-runs the promotion saga for{" "}
            <span className="font-mono">{targetIdentity}</span>. The admin
            approval decision is unchanged; only the publish-to-final +
            digest-verify steps are retried.
            {promotionError ? (
              <span className="mt-2 block break-words rounded border border-line bg-surface-strong p-2 font-mono text-xs">
                Last error: {promotionError}
              </span>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <form action={retryPromotionAction}>
          <Input type="hidden" name="submission_id" value={submissionId} />
          <Input type="hidden" name="return_status" value={returnStatus} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit">Retry</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
