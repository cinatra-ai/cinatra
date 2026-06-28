"use client";

/**
 * Withdraw a pending submission. Confirmation dialog (no typed-confirmation;
 * the blast radius is one pending submission and the vendor can resubmit) —
 * single button → Dialog → "Withdraw" button posts the Server Action.
 */

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

import { withdrawSubmissionAction } from "./actions";

export function WithdrawSubmissionButton({
  submissionId,
  targetIdentity,
}: {
  submissionId: string;
  targetIdentity: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          Withdraw
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Withdraw submission?</DialogTitle>
          <DialogDescription>
            This permanently cancels the pending submission for{" "}
            <span className="font-mono">{targetIdentity}</span>. The staged
            tarball will be reaped. You can resubmit the same version later.
          </DialogDescription>
        </DialogHeader>
        <form action={withdrawSubmissionAction}>
          <Input type="hidden" name="submission_id" value={submissionId} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive">
              Withdraw
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
