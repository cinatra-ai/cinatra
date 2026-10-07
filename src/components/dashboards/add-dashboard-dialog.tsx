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
 *   - **Add from the installed catalog (B)** — an opaque slot the landing fills
 *     server-side (cinatra#2474 PR4's read; PR5's instantiate action). The slot
 *     stays opaque: this dialog neither builds nor inspects the section, it only
 *     provides the two things the section cannot know from the server — whether
 *     the actor may create at all, and what to do when a copy lands
 *     (`CatalogAddOutcomeProvider`). When the landing supplies no node the
 *     section renders NOTHING; it deliberately ships no placeholder, because a
 *     section announcing a catalog an instance does not have would advertise a
 *     capability the product does not have.
 *
 * The dialog is presentation only. It owns no scope, no actor and no capability
 * — every section is driven by what the server-rendered landing chose to hand
 * down, and every action it can reach re-authorizes server-side.
 *
 * ── THE WORDS BELONG TO THE SURFACE (cinatra#2811 fix leg 4) ───────────────
 * The sentences below are the TENANT tabs'. The amended drawing draws this popup
 * once on the workspace landing (§IX.1, surface `workspace-dashboards-add-popup`)
 * and gives it a title, an opening line, section names and helper lines of its
 * own, so a caller may hand down a `words` object; a caller that hands none keeps
 * the landed words exactly. Two things move with the words:
 *
 *   - each section's ARIA-LABEL becomes its drawn name, so a test finds the
 *     section by the name the drawing gives it;
 *   - a HELPER line sits BELOW its section's controls, where the drawing puts it,
 *     while the tenant tabs' caption stays above them, where they landed it.
 */
import { useRef, useTransition, type ReactElement, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import type { EntityDashboardSummary } from "@cinatra-ai/dashboards/entity-dashboards-contract";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { CatalogAddOutcomeProvider } from "./catalog-add-outcome";
import {
  ScopeReferenceSection,
  type ReferenceAddWords,
} from "./scope-reference-section";
import type { ScopeReferenceSource } from "./scope-dashboards-contract";

/**
 * One surface's own words for this popup (cinatra#2811 fix leg 4). Every field is
 * a sentence the amended drawing draws; nothing here decides anything.
 */
export type AddDashboardDialogWords = {
  /** The popup's title. */
  readonly title: string;
  /** The line under the title. */
  readonly opening: ReactNode;
  /** The Create section's name: its heading and its aria-label. */
  readonly createTitle: string;
  /** The line below the Create control. */
  readonly createHelper: ReactNode;
  /** The Create control's own label. */
  readonly createButton: string;
  /** The Reference section's name: its heading and its aria-label. */
  readonly referenceTitle: string;
  /** The line below the candidate rows. */
  readonly referenceHelper: ReactNode;
  /** The word an addable candidate's control carries on this surface. */
  readonly referenceAdd: ReferenceAddWords;
};

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
  /** Concept B's section (the landing supplies it; `null` where nothing is
   *  eligible). `ReactElement`, not `ReactNode` — see `ScopeAddSources.catalog`. */
  readonly catalog: ReactElement | null;
  /** A reference listing was added — the owner closes the popup. */
  readonly onReferenceAdded: () => void;
  /** A catalog copy landed (cinatra#2474 PR5) — the owner closes the popup and
   *  adopts the new dashboard into the shell's list. */
  readonly onCatalogAdded: (dashboard: EntityDashboardSummary) => void;
  /** This surface's own words (see the header). Absent keeps the landed ones. */
  readonly words?: AddDashboardDialogWords;
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
  onCatalogAdded,
  words,
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
            {words?.title ??
              (scopeLabel
                ? `Add a dashboard to ${scopeLabel}`
                : "Add a dashboard")}
          </DialogTitle>
          <DialogDescription>
            {words?.opening ??
              (reference
                ? "Create a new dashboard, or list one that already exists — a referenced dashboard’s canonical home does not move."
                : "Choose how to add a dashboard here.")}
          </DialogDescription>
        </DialogHeader>

        {/* The section column carries a stable slot so a conformance walk can
            assert CATEGORICALLY what the popup offers — "exactly these
            sections", in any element shape — instead of counting `<section>`
            tags and hoping nothing hides as a div. */}
        <div data-slot="add-dashboard-sections" className="flex flex-col gap-5">
          {canCreate ? (
            <section
              aria-label={words ? words.createTitle : "Create a new dashboard"}
              className="flex flex-col gap-2.5"
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-foreground">
                    {words?.createTitle ?? "Create new"}
                  </span>
                  {words ? null : (
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      A blank dashboard you name. It is YOURS on this page — it
                      joins the dashboard list above, not the scope&rsquo;s
                      collection.
                    </span>
                  )}
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
                  {words?.createButton ?? "Create…"}
                </Button>
              </div>
              {/* The drawn helper sits BELOW the control, where §IX.1 puts it. */}
              {words ? (
                <span className="text-xs text-muted-foreground">
                  {words.createHelper}
                </span>
              ) : null}
            </section>
          ) : null}

          {reference ? (
            <section
              aria-label={
                words ? words.referenceTitle : "Reference an existing dashboard"
              }
              className="flex flex-col gap-2.5"
            >
              <span>
                <span className="block text-xs font-semibold text-foreground">
                  {words?.referenceTitle ?? "Reference an existing dashboard"}
                </span>
                {words ? null : (
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Lists it here as a reference — its{" "}
                    <b className="font-semibold text-foreground">
                      canonical home does not move
                    </b>
                    . Only dashboards this scope can already see are listable.
                  </span>
                )}
              </span>
              <ScopeReferenceSection
                source={reference}
                addWords={words?.referenceAdd}
                // The listing landed: close (the candidate pool the section is
                // showing no longer holds — the added dashboard has left it)
                // and re-render the server tree so the collection panel below
                // the shell picks the new row up.
                onAdded={() => {
                  onReferenceAdded();
                  startTransition(() => router.refresh());
                }}
              />
              {/* The drawn helper sits BELOW the rows, where §IX.1 puts it. */}
              {words ? (
                <span className="text-xs text-muted-foreground">
                  {words.referenceHelper}
                </span>
              ) : null}
            </section>
          ) : null}

          {/* Concept B's mount point (cinatra#2474 PR4), with the two client
              facts the server-built section cannot carry (PR5): the create
              authority its Add is gated on — the SAME `canCreate` the Create
              section above is gated on, so the popup can never offer a catalog
              Add to a principal it will not offer Create to — and where to
              report a landed copy. */}
          <CatalogAddOutcomeProvider canAdd={canCreate} onAdded={onCatalogAdded}>
            {catalog}
          </CatalogAddOutcomeProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
