"use client";

import { useState } from "react";
import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { archiveConfirmCopy, removeConfirmCopy } from "./uninstall-confirm-message";

type ButtonVariant = ComponentProps<typeof Button>["variant"];
type ButtonSize = ComponentProps<typeof Button>["size"];

export type DestinationVariant = "archive" | "remove";

// WR-06 fix: dropped packageName / packageVersion from props — they were
// declared and silenced via `void rest`, providing no runtime value and
// inviting future maintainers to assume the props were used somewhere.
// The bound server action (`action` prop) already has packageName +
// packageVersion baked in; the dialog renders `packageTitle` for display.
type RegistryUninstallFormProps = {
  // Action is a bound server action that already has packageName/packageVersion baked in.
  action: (formData?: FormData) => void | Promise<void>;
  packageTitle: string;
  destinationVariant: DestinationVariant;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
};

export function RegistryUninstallForm({
  action,
  packageTitle,
  destinationVariant,
  variant = "outline",
  size,
  className,
}: RegistryUninstallFormProps) {
  const [open, setOpen] = useState(false);

  const copy =
    destinationVariant === "archive"
      ? archiveConfirmCopy(packageTitle)
      : removeConfirmCopy(packageTitle);

  const confirmButtonVariant: ButtonVariant =
    destinationVariant === "remove" ? "destructive" : "outline";

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
      >
        Uninstall
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {/* Cancel is autoFocus per UI-SPEC accessibility note */}
            <Button
              type="button"
              variant="outline"
              autoFocus
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            {/* Confirm is a form-submit so it fires the bound server action */}
            <form action={action}>
              <Button type="submit" variant={confirmButtonVariant}>
                {copy.confirmLabel}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
