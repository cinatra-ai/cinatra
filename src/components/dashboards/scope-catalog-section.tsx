/**
 * `<ScopeCatalogSection>` — concept B's section in the unified Add-dashboard
 * popup (cinatra#2474 PR4). It fills the opaque slot PR3 left behind.
 *
 * PRESENTATION ONLY, and deliberately SERVER-RENDERED: the landing takes the
 * catalog read during its own server render and hands the finished node across
 * through `ScopeAddSourcesProvider`'s `catalog` prop. No `"use client"`, no
 * state, no action — so nothing here can be driven from a browser, and the rows
 * are already-authorized display metadata by the time they exist.
 *
 * ── WHAT IT DOES NOT OFFER, AND WHY ────────────────────────────────────────
 * NO add/create control. The instantiate action is PR5 by the issue's own
 * ordering ("PR4 (eligibility) before PR5 (the write)"), so in PR4 there is
 * nothing to press, and a control that cannot act is a promise the product
 * cannot keep — the same judgment PR3 made when it refused to ship a placeholder
 * catalog section.
 *
 * NO link on a row either. A template row's canonical surface is governed by the
 * TEMPLATE'S OWN owner tuple through `resolveDashboardAccess`, which is a
 * different gate from the extension access policy this list passed; a row could
 * therefore link somewhere this very actor gets a 404 from. An affordance that
 * may not work is not better than no affordance.
 *
 * So the section states the plain fact and stops. It makes no claim about when
 * adding will exist.
 *
 * The copy is also careful about TENSE. The read proves these dashboards were
 * materialized by an installed, currently-live extension and are still
 * published; it does NOT re-read the pack manifest, so it cannot say the
 * extension still SHIPS them right now (see `installed-catalog-read.ts`). The
 * wording therefore says what happened ("have added to this workspace") rather
 * than making a present-tense claim the read cannot back (codex convergence r1).
 *
 * ── NO EMPTY STATE HERE, BY DESIGN ─────────────────────────────────────────
 * This component renders only when there is at least one row: the landing passes
 * `catalog={null}` for an empty (or failed) read, so no section exists at all
 * rather than an "installed catalog — nothing available" frame. An empty catalog
 * section would advertise a capability the instance does not have (PR3's ruling,
 * inherited), and — because PR3's toolbar keys `offersUnifiedAdd` on the slot
 * being non-null — a non-null empty node would also make Personal's
 * "+ New dashboard" stop opening the name prompt and start opening a popup with
 * nothing in it. The §X state matrix's `empty` belongs to the Dashboards tab and
 * to the add-to-scope picker; it does not require an empty catalog frame.
 */
import { Puzzle } from "lucide-react";

import type { CatalogTemplateView } from "@/lib/dashboards/installed-catalog-contract";

export type ScopeCatalogSectionProps = {
  /** Already-eligible rows. NEVER render this with an empty array — pass
   *  `catalog={null}` instead (see the header). */
  readonly templates: readonly CatalogTemplateView[];
};

export function ScopeCatalogSection({ templates }: ScopeCatalogSectionProps) {
  if (templates.length === 0) return null;

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
          <b className="font-semibold text-foreground">
            Adding one isn&rsquo;t available yet
          </b>
          .
        </span>
      </span>
      <ul className="flex flex-col gap-1.5">
        {templates.map((t) => (
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
          </li>
        ))}
      </ul>
    </section>
  );
}
