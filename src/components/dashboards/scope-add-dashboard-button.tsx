"use client";
/**
 * The Dashboards tab's own Add affordance (cinatra#2807 fix leg 3).
 *
 * The ratified drawing draws it in the tab body's caption row — "The dashboards
 * in Team: Growth." on the left, an "Add dashboard" button on the right — and
 * gates it to a scope manager: "Add dashboard and every row's Remove appear only
 * to a principal who may write (manage) this scope's Dashboards collection …
 * Suppression, not a disabled control: a management action the member cannot
 * take is not rendered."
 *
 * It replaces the toolbar-mounted trigger the affordance had while the tab body
 * was a dashboard canvas with a toolbar band above it. That band is not drawn on
 * this tab, so it is gone, and the button it carried moves to where the drawing
 * puts it.
 *
 * WHAT IT OFFERS, and what it deliberately does not. The drawn Add is an
 * ADD-TO-SCOPE action: it lists a dashboard in THIS scope's collection, which is
 * the collection this tab renders. The popup's other two options write somewhere
 * else — both the create path and the installed-catalog copy write a row owned by
 * the acting USER (`owner_level='user'`), and the scope's home read is
 * `owner_level=<scope kind> AND owner_id=<scope id>` (project: `project_id`), so
 * such a row is never in this tab's list. Offering them here would report success
 * and then show the viewer nothing (fix leg 3, convergence round). They are
 * therefore not offered: `canCreate` is false and no catalog node is passed.
 * Where those two paths belong on this drawing is a question for the maintainer,
 * recorded on the pull request rather than answered here.
 *
 * WHAT IT DECIDES: nothing. The one source it opens is handed down by the server
 * render through `ScopeAddSourcesProvider`, which supplies `reference` only to a
 * principal who may write the scope — so this component renders the affordance
 * exactly when the server already decided the viewer may take it, and every
 * action re-authorizes server-side regardless.
 */
import { useState } from "react";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";

import { AddDashboardDialog } from "./add-dashboard-dialog";
import { useScopeAddSources } from "./scope-add-sources";

export function ScopeAddDashboardButton() {
  const sources = useScopeAddSources();
  const [addOpen, setAddOpen] = useState(false);

  // §IX.2 suppression at the source: no reference source means the server
  // decided this viewer may not write the collection, so there is no Add here —
  // not a disabled one.
  const reference = sources?.reference ?? null;
  if (!sources || reference === null) return null;

  return (
    <span
      data-conformance-id="scope-dashboards-write-access"
      data-field="manage-controls=collectionAdd.actorMayWriteScope"
      className="contents"
    >
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
        scopeLabel={sources.scopeLabel}
        // The two paths that would write outside this tab's collection are not
        // offered here — see the header.
        canCreate={false}
        onChooseCreate={() => setAddOpen(false)}
        reference={reference}
        catalog={null}
        onReferenceAdded={() => setAddOpen(false)}
        onCatalogAdded={() => setAddOpen(false)}
      />
    </span>
  );
}
