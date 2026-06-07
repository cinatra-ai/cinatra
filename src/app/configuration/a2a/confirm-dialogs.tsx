"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// formatGracePeriod — shared with the rotate confirm dialog
// ---------------------------------------------------------------------------

export function formatGracePeriod(seconds: number): string {
  if (seconds === 0) return "immediate cutover";
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}

// ---------------------------------------------------------------------------
// RotateConfirmDialog — warns about grace period before rotation
// ---------------------------------------------------------------------------

export type RotateConfirmTarget = {
  id: string;
  name: string;
  gracePeriodSeconds: number;
};

type RotateConfirmDialogProps = {
  target: RotateConfirmTarget | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function RotateConfirmDialog({
  target,
  isPending,
  onCancel,
  onConfirm,
}: RotateConfirmDialogProps) {
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate credentials for {target?.name}?</DialogTitle>
          <DialogDescription>
            A new client ID and client secret will be generated. The previous client ID will
            continue to work for{" "}
            <strong>
              {target ? formatGracePeriod(target.gracePeriodSeconds) : "the configured grace period"}
            </strong>{" "}
            after rotation, then stop accepting new tokens. Already-issued tokens for the previous
            client remain valid until they expire — use Revoke for an immediate cutover.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isPending}>
            Rotate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// DeleteConfirmDialog — warns about permanent removal
// ---------------------------------------------------------------------------

export type DeleteConfirmTarget = {
  id: string;
  name: string;
};

type DeleteConfirmDialogProps = {
  target: DeleteConfirmTarget | null;
  isPending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DeleteConfirmDialog({
  target,
  isPending,
  onCancel,
  onConfirm,
}: DeleteConfirmDialogProps) {
  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete service account {target?.name}?</DialogTitle>
          <DialogDescription>
            This permanently removes the service account row and the underlying OAuth client. Any
            token issued for this client will fail subsequent A2A calls. This cannot be undone —
            use Revoke if you only need to disable access while preserving the audit record.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
