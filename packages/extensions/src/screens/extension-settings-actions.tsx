"use client";

// ---------------------------------------------------------------------------
// Client action affordances for the per-extension Settings page (design §V).
//
// Destructive and one-way actions render the red `destructive` button and
// ALWAYS confirm (§V). Each confirm submits a bound server action (identity is
// baked in server-side); Force-delete additionally captures a required typed
// reason for the lifecycle audit log. Disabled-in-place (locked / system
// extensions) renders the button greyed with the reason as its tooltip — the
// server enforcement is authoritative (this is only the affordance).
// ---------------------------------------------------------------------------

import { useState, type ComponentProps, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type ButtonVariant = ComponentProps<typeof Button>["variant"];

/** A trigger button that is disabled-in-place with a reason tooltip. */
export function DisabledActionButton({
  label,
  icon,
  variant = "outline",
  reason,
}: {
  label: string;
  icon?: ReactNode;
  variant?: ButtonVariant;
  reason: string;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      disabled
      aria-disabled="true"
      title={reason}
      className="flex-none"
    >
      {icon}
      {label}
    </Button>
  );
}

/**
 * A destructive / one-way action rendered as a trigger button that opens a
 * confirmation dialog; confirming submits the bound server action.
 */
export function ConfirmActionButton({
  triggerLabel,
  triggerIcon,
  triggerVariant = "destructive",
  title,
  description,
  confirmLabel,
  confirmVariant = "destructive",
  action,
}: {
  triggerLabel: string;
  triggerIcon?: ReactNode;
  triggerVariant?: ButtonVariant;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonVariant;
  /** Bound server action (identity baked in); redirects on success. */
  action: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant={triggerVariant}
        className="flex-none"
        onClick={() => setOpen(true)}
      >
        {triggerIcon}
        {triggerLabel}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" autoFocus onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <form action={action}>
              <Button type="submit" variant={confirmVariant}>
                {confirmLabel}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Force-delete confirmation (§V): hard delete + dangling-reference cleanup,
 * bypasses restore, and demands a typed reason for the audit log. The submit
 * stays disabled until a non-empty reason is entered; the reason posts as
 * FormData to the bound server action, which re-validates it (never trusts the
 * disabled-submit affordance).
 */
export function ForceDeleteDialog({
  displayName,
  triggerIcon,
  action,
}: {
  displayName: string;
  triggerIcon?: ReactNode;
  /** Bound server action reading `reason` from FormData; redirects on success. */
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <>
      <Button
        type="button"
        variant="destructive"
        className="flex-none"
        onClick={() => setOpen(true)}
      >
        {triggerIcon}
        Force-delete…
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setReason("");
        }}
      >
        <DialogContent>
          <form action={action}>
            <DialogHeader>
              <DialogTitle className="text-destructive">
                Force-delete {displayName}?
              </DialogTitle>
              <DialogDescription>
                Permanently deletes the extension and cleans up dangling
                references (agent runs, dependent templates). This{" "}
                <strong className="text-destructive">bypasses restore</strong> —
                there is nothing to recover.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-3 flex flex-col gap-1.5">
              <Label htmlFor="force-delete-reason">
                Reason <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="force-delete-reason"
                name="reason"
                required
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Superseded by v2 — cleaning up the abandoned build"
              />
              <p className="text-xs text-muted-foreground">
                Recorded in the lifecycle audit log. Required.
              </p>
            </div>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setOpen(false);
                  setReason("");
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="destructive" disabled={trimmed.length === 0}>
                {triggerIcon}
                Force-delete
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
