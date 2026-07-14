"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

/**
 * §V Archive affordance for a dynamic type (Types & approvals). Archiving is a
 * destructive-ish lifecycle transition: there is NO in-app un-archive — recovery
 * requires editing the database directly — so it goes through an explicit
 * confirmation (preserving the retired /data/types screen's Archive dialog).
 * The bound-or-unbound archive server action is passed in from the server
 * component; it re-checks admin authorization and revalidates on the server.
 */
export function ArchiveTypeButton({
  objectTypeId,
  action,
}: {
  objectTypeId: string;
  action: (objectTypeId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={(next) => (pending ? undefined : setOpen(next))}>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-action="archive-type -> archived"
        >
          Archive
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Archive <span className="font-mono">{objectTypeId}</span>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Archived types are hidden from the default registry view but remain
            in the database for audit history. There is no in-app un-archive —
            recovery requires editing the database directly. The classifier may
            propose this type again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await action(objectTypeId);
                setOpen(false);
              })
            }
          >
            {pending ? "Archiving…" : "Archive type"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
