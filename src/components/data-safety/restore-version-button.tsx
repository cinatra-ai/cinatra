"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { History } from "lucide-react";

import { Button } from "@/components/ui/button";
import { restoreObjectToVersionAction } from "@/components/data-safety/restore-object-version-action";
import { showUndoToast, undoDeepLink } from "@/components/data-safety/undo-toast";

// Inline "Restore to this version" button on a single
// history event. Renders only when the parent panel has
// already decided the event is restore-eligible AND the actor passed
// object.update server-side, so this component never gates on authz itself —
// it is pure click → action → feedback plumbing.
//
// Consumes the MutationResult contract +
// fires <UndoToast>. The toast's "Undo" deep-links to the NEW restore
// change-set's restore modal — undoing the restore itself.
export type RestoreVersionButtonProps = {
  objectId: string;
  targetVersion: number;
};

export function RestoreVersionButton({
  objectId,
  targetVersion,
}: RestoreVersionButtonProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function onClick() {
    startTransition(async () => {
      const result = await restoreObjectToVersionAction({
        objectId,
        targetVersion,
      });
      showUndoToast(result, {
        title: `Restored to version ${targetVersion}`,
        onUndo: (changeSetId) => router.push(undoDeepLink(changeSetId)),
      });
      if (result.ok) router.refresh();
    });
  }

  return (
    <Button
      variant="outline"
      size="xs"
      onClick={onClick}
      disabled={pending}
      aria-label={`Restore to version ${targetVersion}`}
    >
      <History data-icon="inline-start" />
      {pending ? "Restoring…" : "Restore to this version"}
    </Button>
  );
}
