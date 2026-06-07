"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import {
  approveMergeProposalAction,
  rejectMergeProposalAction,
} from "@/app/data-safety/merge-proposals/[proposalId]/actions";

export type MergeProposalActionsProps = {
  proposalId: string;
  objectId: string;
  baseVersion: number;
  proposedFieldKeys: readonly string[];
};

export function MergeProposalActions(props: MergeProposalActionsProps) {
  const router = useRouter();
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onApprove() {
    setError(null);
    startTransition(async () => {
      const result = await approveMergeProposalAction({ proposalId: props.proposalId });
      if (result.ok) {
        setApproveOpen(false);
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }
  function onReject() {
    setError(null);
    startTransition(async () => {
      const result = await rejectMergeProposalAction({ proposalId: props.proposalId });
      if (result.ok) {
        setRejectOpen(false);
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }

  return (
    <>
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <X className="size-4 mr-1.5" />
            Reject
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject merge proposal</DialogTitle>
            <DialogDescription>
              This marks the proposal rejected. No object data changes.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="default" onClick={onReject} disabled={pending}>
              {pending ? "Rejecting…" : "Confirm reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={approveOpen} onOpenChange={setApproveOpen}>
        <DialogTrigger asChild>
          <Button variant="default" size="sm">
            <Check className="size-4 mr-1.5" />
            Approve
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve merge proposal</DialogTitle>
            <DialogDescription>
              This applies the proposed fields ({props.proposedFieldKeys.length})
              over the current object's data via the canonical history-aware
              writer using the captured baseVersion (v{props.baseVersion}) as
              the CAS expectation. A concurrent write to the object since the
              proposal was submitted will surface as a typed VersionConflict
              and the proposal returns to pending for re-review.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setApproveOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="default" onClick={onApprove} disabled={pending}>
              {pending ? "Applying…" : "Confirm approve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
