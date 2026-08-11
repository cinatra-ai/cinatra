"use client";
/**
 * `<ScopeCatalogSection>` — concept B's section in the unified Add-dashboard
 * popup (cinatra#2474 PR4; made ACTIONABLE by PR5). It fills the opaque slot PR3
 * left behind.
 *
 * Its ELEMENT is still created during the landing's server render
 * (`buildScopeCatalogNode`), so the rows are already-authorized display metadata
 * by the time they exist and no candidate list is ever fetched from the browser.
 * What PR5 adds is a single bound server action per section — `source.add` — and
 * the client state to drive it.
 *
 * ── WHAT IT OFFERS, AND WHAT IT STILL DOES NOT ─────────────────────────────
 * ONE control per row: Add. Pressing it copies the template into the acting
 * user's own collection on this page and hands the created dashboard up so the
 * popup closes and the shell selects it.
 *
 * Still NO link on a row. A template's canonical surface answers to
 * `resolveDashboardAccess` over the TEMPLATE'S OWN owner tuple, a different gate
 * from the extension access policy these rows passed, so a row could link
 * somewhere this very actor gets a 404 from. An affordance that may not work is
 * not better than no affordance — PR4's judgment, unchanged.
 *
 * ── THE ADD IS A CREATE, SO IT IS GATED LIKE ONE ───────────────────────────
 * `canAdd` comes from the hosting popup's server-derived `canCreate` (through
 * `CatalogAddOutcomeProvider`), the same flag the toolbar keys the popup on.
 * Without it the section renders its rows and offers NO control — suppression,
 * not a disabled button, matching how every other write affordance on this
 * surface handles missing authority. A control the writer would refuse is not
 * shipped.
 *
 * ── THE COPY'S CONTRACT, IN THE COPY ───────────────────────────────────────
 * The section says what the add actually does: an ordinary dashboard of the
 * actor's own on this page, not a link to the extension's. It is also careful
 * about TENSE — the read proves these dashboards were materialized by an
 * installed, currently-live extension and are still published; it does NOT
 * re-read the pack manifest, so it cannot say the extension still SHIPS them
 * right now. The wording therefore says what happened ("have added to this
 * workspace") rather than making a present-tense claim the read cannot back
 * (codex convergence r1). The WRITE does re-check that (`no-longer-declared`),
 * which is why a stale row can still be listed and still refuse on Add.
 *
 * ── NO EMPTY STATE HERE, BY DESIGN ─────────────────────────────────────────
 * This component renders only when there is at least one row: the landing passes
 * `catalog={null}` for an empty (or failed) read, so no section exists at all
 * rather than an "installed catalog — nothing available" frame. An empty catalog
 * section would advertise a capability the instance does not have (PR3's ruling,
 * inherited), and — because the toolbar keys the popup's existence on the slot
 * being non-null — a non-null empty node would also make Personal's
 * "+ New dashboard" stop opening the name prompt and start opening a popup with
 * nothing in it.
 */
import { useState } from "react";
import { Puzzle } from "lucide-react";

import { toast } from "@/lib/cinatra-toast";
import { Button } from "@/components/ui/button";
import {
  CATALOG_ADD_REASON_COPY,
  type CatalogTemplateView,
  type ScopeCatalogSource,
} from "@/lib/dashboards/installed-catalog-contract";

import { useCatalogAddOutcome } from "./catalog-add-outcome";

export type ScopeCatalogSectionProps = {
  /** Already-eligible rows. NEVER render this with an empty array — pass
   *  `catalog={null}` instead (see the header). */
  readonly templates: readonly CatalogTemplateView[];
  /** The bound server action (cinatra#2474 PR5). */
  readonly source: ScopeCatalogSource;
};

export function ScopeCatalogSection({
  templates,
  source,
}: ScopeCatalogSectionProps) {
  const outcome = useCatalogAddOutcome();
  const [busyId, setBusyId] = useState<string | null>(null);
  // A template that has just been copied leaves the addable set — its name is
  // now taken in this very collection, so pressing Add again would refuse.
  // Dropping the row is the truthful reflection of what the server would now
  // say, and it matches how the reference picker treats a candidate it has just
  // consumed.
  const [addedIds, setAddedIds] = useState<readonly string[]>([]);

  if (templates.length === 0) return null;
  const canAdd = outcome?.canAdd === true;
  const visible = templates.filter((t) => !addedIds.includes(t.templateId));
  if (visible.length === 0) return null;

  const onAdd = (template: CatalogTemplateView) => {
    if (!outcome) return;
    setBusyId(template.templateId);
    void source
      .add(template.templateId)
      .then((res) => {
        setBusyId(null);
        if (res.ok) {
          setAddedIds((prev) => [...prev, template.templateId]);
          toast.success(`“${res.dashboard.name}” added to your dashboards`);
          outcome.onAdded(res.dashboard);
          return;
        }
        toast.error(CATALOG_ADD_REASON_COPY[res.reason]);
      })
      // A REJECTED action (transport / server fault) must clear the busy state
      // too — otherwise the button stays "Adding…" forever with no way back.
      .catch(() => {
        setBusyId(null);
        toast.error(CATALOG_ADD_REASON_COPY.failed);
      });
  };

  return (
    <section
      aria-label="Add from the installed catalog"
      data-slot="add-dashboard-catalog"
      className="flex flex-col gap-2.5"
    >
      <span>
        <span className="block text-xs font-semibold text-foreground">
          From the installed catalog
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Dashboards that installed extensions have added to this workspace.{" "}
          {canAdd ? (
            <>
              Adding one makes{" "}
              <b className="font-semibold text-foreground">
                your own copy on this page
              </b>
              .
            </>
          ) : (
            <b className="font-semibold text-foreground">
              You can&rsquo;t add dashboards here.
            </b>
          )}
        </span>
      </span>
      <ul className="flex flex-col gap-1.5">
        {visible.map((t) => (
          <li
            key={t.templateId}
            data-slot="catalog-row"
            className="soft-panel flex flex-wrap items-center gap-x-2.5 gap-y-1 border-line px-3 py-2"
          >
            <Puzzle
              aria-hidden="true"
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">
                {t.name}
              </span>
              <span className="mt-0.5 block truncate font-mono text-badge-2xs text-muted-foreground">
                {t.packageName}
              </span>
            </span>
            {canAdd ? (
              <Button
                type="button"
                size="xs"
                className="flex-none"
                disabled={busyId !== null}
                data-action="add-from-catalog -> catalog-dashboard-added"
                onClick={() => onAdd(t)}
              >
                {busyId === t.templateId ? "Adding…" : "Add"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
