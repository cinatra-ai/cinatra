"use client";
/**
 * The workspace Dashboards tab's Add affordance (cinatra#2811, per-scope
 * surfaces S5; the amended drawing §IX.1 and §IX.3).
 *
 * "The same single Add dashboard popup" the other scopes open, with its
 * sections in the drawn order:
 *
 *   - Create new: offered to EVERY viewer. The workspace tab is a per-user
 *     shell ("each member reads their own list"), and "a dashboard this tab's
 *     popup creates ... homes in the workspace and shows no Remove, exactly as
 *     Overview does". Choosing it hands off to the shared name prompt
 *     (`EntityDashboardNameDialog`, the one prompt Create and Rename share),
 *     whose submit is the create action the page bound server-side to the
 *     viewer's own workspace ref;
 *   - Reference a dashboard from the scopes below: present only when the page
 *     handed down a reference source, which it does only for a curator
 *     (a platform administrator, or an organization admin), §IX.2 suppression
 *     applied at the source;
 *   - Add from the installed catalog: the cross-organization FEDERATION
 *     (cinatra#2811, item 4). The page builds it from the viewer's member
 *     organizations and hands it down as a finished node, so this component
 *     neither knows nor can name an organization. An empty or failed read
 *     arrives as `null` and the section is simply absent, never a placeholder.
 *
 * Its words are the amended drawing's own for this surface
 * (`WORKSPACE_ADD_WORDS` below): the drawing draws the popup once, on the
 * workspace landing, and the shared dialog takes the words per surface rather
 * than one wording for all of them.
 *
 * It decides nothing: every action re-authorizes server-side.
 */
import { useState, useTransition, type ReactElement } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";

import {
  ENTITY_DASHBOARD_REASON_COPY,
  type MutatedEntityDashboard,
} from "@cinatra-ai/dashboards/entity-dashboards-contract";
import { EntityDashboardNameDialog } from "@cinatra-ai/dashboards/entity-dashboard-toolbar-controls";
import { Button } from "@/components/ui/button";

import {
  AddDashboardDialog,
  type AddDashboardDialogWords,
} from "./add-dashboard-dialog";
import type { ScopeReferenceSource } from "./scope-dashboards-contract";

/**
 * The popup's words, transcribed from the amended drawing's own surface
 * `workspace-dashboards-add-popup` (§IX.1). The drawing draws this popup once,
 * here, and the tenant tabs keep the words they landed with.
 *
 * The one glyph that differs from the drawing is the apostrophe: the drawing is
 * raw HTML and carries a straight one, while every sibling string on these
 * surfaces carries the typographic one. The word is the drawing's; the glyph is
 * the house form.
 */
const WORKSPACE_ADD_WORDS: AddDashboardDialogWords = {
  title: "Add dashboard",
  opening: (
    <>
      One popup, three sections. A reference lists an existing dashboard here as
      a <b className="font-semibold text-foreground">link</b> — its canonical
      home does not move, and{" "}
      <b className="font-semibold text-foreground">
        nobody gains access by the listing alone
      </b>
      .
    </>
  ),
  createTitle: "Create new",
  createHelper: "Homes in the workspace.",
  createButton: "Create",
  referenceTitle: "Reference a dashboard from the scopes below",
  referenceHelper:
    "The link never widens access. A member reads the entry only when they already pass the target\u2019s home access, or a platform administrator marks it visible to everyone (\u00a7IX.4).",
  referenceAdd: { idle: "Reference", busy: "Referencing\u2026" },
};

export function WorkspaceAddDashboardButton({
  createDashboard,
  reference,
  catalog = null,
}: {
  /** Create a workspace dashboard (bound server-side to the viewer's own ref). */
  readonly createDashboard: (name: string) => Promise<MutatedEntityDashboard>;
  /** The reference section's actions, or null for a viewer who curates none. */
  readonly reference: ScopeReferenceSource | null;
  /** The federated installed-catalog section, or null when it has no rows. */
  readonly catalog?: ReactElement | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [nameOpen, setNameOpen] = useState(false);

  return (
    <span className="contents">
      <Button
        type="button"
        size="sm"
        className="flex-none"
        data-action="open-add-picker -> add-picker-open"
        onClick={() => setAddOpen(true)}
      >
        <Plus data-icon="inline-start" aria-hidden />
        Add dashboard
      </Button>
      <AddDashboardDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        words={WORKSPACE_ADD_WORDS}
        scopeLabel={null}
        canCreate
        onChooseCreate={() => {
          setAddOpen(false);
          setNameOpen(true);
        }}
        reference={reference}
        catalog={catalog}
        onReferenceAdded={() => setAddOpen(false)}
        onCatalogAdded={() => {
          setAddOpen(false);
          startTransition(() => router.refresh());
        }}
      />
      <EntityDashboardNameDialog
        open={nameOpen}
        onOpenChange={setNameOpen}
        title="New dashboard"
        description="It homes in the workspace, beside your Overview."
        submitLabel="Create"
        onSubmit={async (name) => {
          const result = await createDashboard(name);
          if (result.ok) {
            startTransition(() => router.refresh());
            return { ok: true };
          }
          return { ok: false, message: ENTITY_DASHBOARD_REASON_COPY[result.reason] };
        }}
      />
    </span>
  );
}
