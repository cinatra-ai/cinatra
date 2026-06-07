"use client";

import { useState, useTransition } from "react";
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
import { rollbackAgentTemplate } from "./rollback-actions";
import { toast } from "@/lib/cinatra-toast";
import { useRouter } from "next/navigation";

type RollbackButtonProps = {
  templateId: string;
  targetVersionId: string;
  targetSemver: string;
  disabled?: boolean;
};

export function RollbackButton({
  templateId,
  targetVersionId,
  targetSemver,
  disabled = false,
}: RollbackButtonProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleConfirm = () => {
    startTransition(async () => {
      const result = await rollbackAgentTemplate(templateId, targetVersionId);
      if (result.ok) {
        toast.success(`Restored to v${targetSemver}`);
        setOpen(false);
        router.refresh();
      } else {
        toast.error(`Restore failed: ${result.error}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled}>
          Restore
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Restore to v{targetSemver}?</DialogTitle>
          <DialogDescription>
            The live template will use the contents of v{targetSemver}. All version history stays
            intact — the &quot;current&quot; indicator simply moves to this version. You can
            restore to any version at any time.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={isPending}>
            {isPending ? "Restoring…" : "Confirm restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
