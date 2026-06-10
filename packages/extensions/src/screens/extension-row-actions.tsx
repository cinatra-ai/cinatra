"use client";

// ExtensionRowActions client component.
// Implements the per-row overflow menu (DropdownMenu) with:
//   - "Promote to public…" (active when origin.visibility === 'private')
//   - "Demote to private" (disabled-with-tooltip when origin.visibility === 'public')
// Confirmation via AlertDialog (not Dialog — blocking decision semantics).
// Dispatches promoteExtensionToPublicAction server action on confirm.
//
// Locked copy strings:
//   Menu item (active):  "Promote to public…"
//   Menu item (disabled): "Demote to private"
//   Disabled tooltip:    "Demotion not supported in v1 — contact ops"
//   AlertDialog title:   "Promote to public?"
//   AlertDialog body:    "This will republish the extension to the public registry. Existing installs are unaffected. Proceed?"
//   Confirm button:      "Promote to public"
//   Cancel button:       "Cancel"

import * as React from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { MoreHorizontal } from "lucide-react";
import { promoteExtensionToPublicAction } from "@cinatra-ai/extensions/actions";
import { toast } from "@/lib/cinatra-toast";

type ExtensionRowActionsProps = {
  packageName: string;
  packageVersion: string;
  /** Current visibility from origin.visibility — drives which menu item is shown. */
  visibility: "public" | "private";
};

export function ExtensionRowActions({
  packageName,
  packageVersion,
  visibility,
}: ExtensionRowActionsProps) {
  const [promoteOpen, setPromoteOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);

  async function handlePromote() {
    setPending(true);
    try {
      await promoteExtensionToPublicAction({ packageName, packageVersion });
      setPromoteOpen(false);
      // Page-level refresh: revalidatePath is called server-side by the action;
      // a simple reload picks up the updated origin.visibility from the DB.
      window.location.reload();
    } catch {
      // Server-action errors are masked in production builds — show friendly,
      // operation-specific copy instead of the raw caught message (#20).
      toast.error("Could not promote the extension to public.");
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Extension actions"
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="sr-only">Extension actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {visibility === "private" ? (
            <DropdownMenuItem onSelect={() => setPromoteOpen(true)}>
              Promote to public…
            </DropdownMenuItem>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* Wrap in <span> so Tooltip fires even on the disabled item
                    (disabled elements cannot receive pointer events directly — shadcn/Radix pattern). */}
                <span>
                  <DropdownMenuItem disabled>Demote to private</DropdownMenuItem>
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Demotion not supported in v1 — contact ops
              </TooltipContent>
            </Tooltip>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={promoteOpen} onOpenChange={setPromoteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Promote to public?</AlertDialogTitle>
            <AlertDialogDescription>
              This will republish the extension to the public registry. Existing installs are unaffected. Proceed?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="promote-confirm-btn"
              onClick={handlePromote}
              disabled={pending}
            >
              {pending ? "Promoting..." : "Promote to public"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
