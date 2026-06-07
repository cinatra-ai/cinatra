"use client";

import { useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Undo2 } from "lucide-react";

import { stripOpenRestoreParam } from "@/components/data-safety/url-params";

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

export type RestoreModalProps = {
  changeSetId: string;
  restorable: boolean;
  restorableReason: string | null;
  affectedObjectCount: number;
  // Optional summary lines per affected object (rendered as a list).
  diffLines: ReadonlyArray<{ objectId: string; objectType: string; description: string }>;
  // The server action to invoke on confirm. Returns { ok: true } on success
  // or { ok: false, reason } on failure.
  action: (input: { changeSetId: string }) => Promise<
    | { ok: true; restoreChangeSetId: string; appliedEventCount: number }
    | { ok: false; reason: string }
  >;
  // Open on mount for `?openRestore=1`
  // deep-links. Idempotent + back-button safe — closing the modal strips the
  // param via router.replace so it doesn't reopen on back/forward unless the
  // URL still carries it.
  defaultOpen?: boolean;
};

export function RestoreModal(props: RestoreModalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const [pending, startTransition] = useTransition();

  // Idempotent + back-button-safe URL handling: when the modal closes, strip
  // `?openRestore=1` via router.replace (not push) so it leaves no history
  // entry and never reopens on back/forward unless the URL still asks.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next && searchParams.get("openRestore")) {
      const stripped = stripOpenRestoreParam(
        pathname,
        searchParams.toString(),
      );
      router.replace(stripped, { scroll: false });
    }
  }
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<
    | { restoreChangeSetId: string; appliedEventCount: number }
    | null
  >(null);

  function onConfirm() {
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const result = await props.action({ changeSetId: props.changeSetId });
      if (result.ok) {
        setSuccess({
          restoreChangeSetId: result.restoreChangeSetId,
          appliedEventCount: result.appliedEventCount,
        });
        router.refresh();
      } else {
        setError(result.reason);
      }
    });
  }

  // a11y — disabled-explainer via aria-describedby +
  // a visible muted-foreground hint instead of relying only on the
  // `title` attribute (which screen readers and keyboard users may miss).
  const explainerId = `restore-explainer-${props.changeSetId.slice(0, 8)}`;
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div className="flex items-center gap-2">
        {!props.restorable && props.restorableReason ? (
          <span
            id={explainerId}
            className="text-xs text-muted-foreground"
            role="status"
          >
            {props.restorableReason}
          </span>
        ) : null}
        <DialogTrigger asChild>
          <Button
            variant="default"
            size="sm"
            disabled={!props.restorable}
            aria-describedby={
              !props.restorable && props.restorableReason ? explainerId : undefined
            }
            aria-label={
              props.restorable
                ? "Restore this change-set"
                : `Restore disabled: ${props.restorableReason ?? "non-restorable"}`
            }
          >
            <Undo2 data-icon="inline-start" />
            Restore
          </Button>
        </DialogTrigger>
      </div>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restore change-set</DialogTitle>
          <DialogDescription>
            This will append a new change-set that brings the affected{" "}
            {props.affectedObjectCount} object
            {props.affectedObjectCount === 1 ? "" : "s"} back to their
            pre-change state. The original change-set is preserved
            unchanged.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="soft-panel p-4">
            <h3 className="text-sm font-medium mb-2 text-foreground">
              Diff preview
            </h3>
            {props.diffLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No changes detected.
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {props.diffLines.map((line) => (
                  <li
                    key={line.objectId}
                    className="flex items-start gap-2 text-foreground"
                  >
                    <span className="font-mono text-xs text-muted-foreground">
                      {line.objectType}
                    </span>
                    <span className="flex-1">{line.description}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {error ? (
            <div className="soft-panel p-4 border-destructive">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          ) : null}

          {success ? (
            <div className="soft-panel p-4 border-primary">
              <p className="text-sm text-foreground">
                Restored {success.appliedEventCount} event
                {success.appliedEventCount === 1 ? "" : "s"}. New change-set:
                <span className="font-mono ml-1">
                  {success.restoreChangeSetId.slice(0, 16)}…
                </span>
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={onConfirm}
            disabled={pending || !!success}
          >
            {pending ? "Restoring…" : "Confirm restore"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
