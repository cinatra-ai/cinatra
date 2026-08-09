"use client";
/**
 * `<AddDashboardDialog>` — THE unified "Add dashboard" popup (cinatra#2474 PR3).
 *
 * One dialog, launched from the Dashboards tab's toolbar, consolidating every
 * way a dashboard arrives on an entity scope:
 *
 *   - **Create new** — a blank dashboard the user names. Choosing it hands off
 *     to the preserved `<EntityDashboardNameDialog>` (the same prompt Rename
 *     uses), so the name-entry + inline server-validation logic is not
 *     duplicated. The hand-off is a two-step flow rather than a nested dialog:
 *     this popup closes, the name prompt opens.
 *   - **Reference an existing dashboard (A)** — the §IX.1 add-to-scope picker,
 *     embedded as `<ScopeReferenceSection>`. Present ONLY when the hosting
 *     landing handed down a reference source, which it does only for a scope
 *     MANAGER (§IX.2 suppression, applied server-side).
 *   - **Add from the installed catalog (B)** — an opaque slot. Concept B's
 *     server-side read is cinatra#2474 PR4 and its instantiate action is PR5;
 *     until PR4 supplies the node this section renders NOTHING. It deliberately
 *     does not ship a placeholder: a section announcing a catalog before any
 *     catalog read exists would advertise a capability the product does not yet
 *     have.
 *
 * The dialog is presentation only. It owns no scope, no actor and no capability
 * — every section is driven by what the server-rendered landing chose to hand
 * down, and every action it can reach re-authorizes server-side.
 */
import { useRef, useTransition, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { ScopeReferenceSection } from "./scope-reference-section";
import type { ScopeReferenceSource } from "./scope-dashboards-contract";

export type AddDashboardDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The scope's entity-named label — titles the dialog "Add a dashboard to
   *  Team: Growth" (§IX.1). `null` on a scope with no add-to-scope target. */
  readonly scopeLabel: string | null;
  /** Server-derived: may the actor create a dashboard on this entity? */
  readonly canCreate: boolean;
  /** Chose "Create new" — the owner closes this dialog and opens the name
   *  prompt. Kept as a hand-off so `EntityDashboardNameDialog` stays the single
   *  name-entry surface for both Create and Rename. */
  readonly onChooseCreate: () => void;
  /** §IX.1 add-to-scope actions — present ONLY for a scope manager. */
  readonly reference: ScopeReferenceSource | null;
  /** Concept B's section (cinatra#2474 PR4 supplies it; `null` until then).
   *  `ReactElement`, not `ReactNode` — see `ScopeAddSources.catalog`. */
  readonly catalog: ReactElement | null;
  /** A reference listing was added — the owner closes the popup. */
  readonly onReferenceAdded: () => void;
};

export function AddDashboardDialog({
  open,
  onOpenChange,
  scopeLabel,
  canCreate,
  onChooseCreate,
  reference,
  catalog,
  onReferenceAdded,
}: AddDashboardDialogProps) {
  // Set for exactly one close: the Create hand-off. See `onCloseAutoFocus`.
  const handingOff = useRef(false);
  const router = useRouter();
  const [, startTransition] = useTransition();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Bounded on BOTH axes: the reference section's candidate list is
        // unbounded, so the popup must shrink to the viewport and scroll inside
        // itself rather than growing past the screen (§X: the add-to-scope
        // picker is a bounded panel; codex convergence added the height bound).
        className="max-h-[85svh] max-w-[520px] overflow-y-auto"
        // On a NORMAL close Radix restores focus to the launching toolbar
        // button, which is right. On the Create hand-off the name prompt opens
        // in the same commit and autofocuses its field, so the restore would
        // yank focus back out of it — decline it for that one close only
        // (codex convergence: the two-dialog focus race).
        onCloseAutoFocus={(event) => {
          if (!handingOff.current) return;
          handingOff.current = false;
          event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {scopeLabel ? `Add a dashboard to ${scopeLabel}` : "Add a dashboard"}
          </DialogTitle>
          <DialogDescription>
            {reference
              ? "Create a new dashboard, or list one that already exists — a referenced dashboard’s canonical home does not move."
              : "Choose how to add a dashboard here."}
          </DialogDescription>
        </DialogHeader>

        {/* The section column carries a stable slot so a conformance walk can
            assert CATEGORICALLY what the popup offers — "exactly these
            sections", in any element shape — instead of counting `<section>`
            tags and hoping nothing hides as a div. */}
        <div data-slot="add-dashboard-sections" className="flex flex-col gap-5">
          {canCreate ? (
            <section
              aria-label="Create a new dashboard"
              className="flex flex-wrap items-center gap-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-semibold text-foreground">
                  Create new
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  A blank dashboard you name. It is YOURS on this page — it
                  joins the dashboard list above, not the scope&rsquo;s
                  collection.
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                className="flex-none"
                onClick={() => {
                  handingOff.current = true;
                  onChooseCreate();
                }}
              >
                <Plus data-icon="inline-start" aria-hidden />
                Create…
              </Button>
            </section>
          ) : null}

          {reference ? (
            <section
              aria-label="Reference an existing dashboard"
              className="flex flex-col gap-2.5"
            >
              <span>
                <span className="block text-xs font-semibold text-foreground">
                  Reference an existing dashboard
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Lists it here as a reference — its{" "}
                  <b className="font-semibold text-foreground">
                    canonical home does not move
                  </b>
                  . Only dashboards this scope can already see are listable.
                </span>
              </span>
              <ScopeReferenceSection
                source={reference}
                // The listing landed: close (the candidate pool the section is
                // showing no longer holds — the added dashboard has left it)
                // and re-render the server tree so the collection panel below
                // the shell picks the new row up.
                onAdded={() => {
                  onReferenceAdded();
                  startTransition(() => router.refresh());
                }}
              />
            </section>
          ) : null}

          {/* Concept B's mount point (cinatra#2474 PR4). */}
          {catalog}
        </div>
      </DialogContent>
    </Dialog>
  );
}
