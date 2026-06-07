"use client";

// Recreate Library danger-zone UI for /configuration/skills → Library tab.
// Renders a destructive-styled card with a type-to-confirm AlertDialog.
// On confirm, posts the form to recreateLibraryAction, which is admin-gated
// server-side as defense in depth.

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "@/lib/cinatra-toast";
import { recreateLibraryAction } from "./actions";

const CONFIRMATION_PHRASE = "recreate library";

export function RecreateLibrarySection() {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [forcePush, setForcePush] = useState(false);
  const [pending, startTransition] = useTransition();

  const canSubmit = confirm.trim().toLowerCase() === CONFIRMATION_PHRASE;

  const handleConfirm = () => {
    if (!canSubmit) return;
    startTransition(async () => {
      try {
        const result = await recreateLibraryAction({
          forcePushEmptyToGitHub: forcePush,
          confirmationPhrase: CONFIRMATION_PHRASE,
        });
        // Surface GitHub push partial failure separately: the local destructive
        // reset may succeed while remote sync fails.
        if (forcePush && !result.forcePushed && result.forcePushError) {
          toast.error(
            `Library recreated locally (${result.truncatedTables.length} tables), ` +
              `but GitHub force-push FAILED: ${result.forcePushError}. ` +
              `Re-run from the Recreate dialog or run pushSkillStoreToGitHub manually.`,
          );
        } else {
          const pushedNote = result.forcePushed ? ` GitHub commit: ${result.commitSha ?? "(empty)"}.` : "";
          toast.success(`Library recreated. Truncated ${result.truncatedTables.length} tables.${pushedNote}`);
        }
        setOpen(false);
        setConfirm("");
        setForcePush(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Recreate failed: ${msg}`);
      }
    });
  };

  return (
    <Card className="border-destructive bg-surface backdrop-blur-none">
      <CardHeader>
        <CardTitle className="text-destructive">Danger zone</CardTitle>
        <CardDescription>
          Permanently destroy and rebuild the skills library. Used for development resets,
          migrations to new layouts, and clearing test data.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          This removes ALL installed skill packages, custom skills, agent-bound skills,
          skill-match results, scheduler state, in-flight path relocations, AND the
          on-disk content under <code>data/skills/</code>. There is no undo.
        </p>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="self-start">
              Recreate library…
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="text-destructive">
                Recreate the skills library?
              </AlertDialogTitle>
              <AlertDialogDescription className="space-y-2">
                <span className="block">
                  This will TRUNCATE every skill-related table (skill_packages,
                  skill_matches, custom_skill_assignments, …), <code>rm -rf</code>{" "}
                  the on-disk skills root, and re-register the BullMQ batch
                  scheduler on an empty slate.
                </span>
                <span className="block font-semibold">
                  This action cannot be undone. Existing skills will not be recovered.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="recreate-confirm" className="text-sm">
                  Type <code>{CONFIRMATION_PHRASE}</code> to confirm
                </Label>
                <Input
                  id="recreate-confirm"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder={CONFIRMATION_PHRASE}
                  autoFocus
                  autoComplete="off"
                  disabled={pending}
                />
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="recreate-push-empty"
                  checked={forcePush}
                  onCheckedChange={(value) => setForcePush(value === true)}
                  disabled={pending}
                />
                <Label htmlFor="recreate-push-empty" className="text-sm cursor-pointer">
                  Also force-push empty state to the configured GitHub skills repository.
                </Label>
              </div>
              <p className="text-xs text-muted-foreground">
                GitHub force-push <strong>does not delete</strong> the remote repository.
                It replaces its contents with the local (now-empty) skills store.
              </p>
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={(event) => {
                  event.preventDefault();
                  handleConfirm();
                }}
                disabled={!canSubmit || pending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {pending ? "Recreating…" : "Yes, recreate library"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
