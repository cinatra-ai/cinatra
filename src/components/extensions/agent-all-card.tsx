"use client";

// ---------------------------------------------------------------------------
// AgentAllCard — one card on the /agents "All Agents" picker (cinatra#1121).
//
// Wraps the shared <InstalledExtensionCard> (the published design-system
// Installed-extensions card, agent variant: coloured accent panel + byline +
// three-line description, Run + "More details", no version/status row) and lifts
// the §V detail-modal open state so the SAME modal is driven by TWO sibling
// hit-areas:
//   • the RIGHT "More details" link (the modal's own linkTrigger), and
//   • the LEFT coloured accent panel — previously inert with a text (I-beam)
//     cursor, now a pointer-cursor click target (owner ruling 2026-07-06:
//     "More details" opens the §V detail modal in place).
//
// The accent panel and the modal live in far-apart card subtrees, so they
// cannot share one Radix Dialog context; this component lifts `open` and both
// hit-areas set it. The accent's `href` is the agent's full-page marketplace
// detail — a no-JS progressive-enhancement fallback; JS opens the modal in
// place. Rows with no marketplace listing (external A2A / unscoped agents —
// detailHref/packageName null) keep the accent INERT (a default cursor, no
// modal, no link) and render Run only.
// ---------------------------------------------------------------------------

import { useState } from "react";
import Link from "next/link";
import { Play, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  InstalledExtensionCard,
  InstalledStatusIndicator,
} from "@/components/extensions/installed-extension-card";
import { AgentDetailModal } from "@/components/extensions/agent-detail-modal";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
import { resolveAgentCardVendor } from "@/components/extensions/agent-card-vendor";
import type { MarketplaceDetailLoadResult } from "@/lib/marketplace-detail-view";

/** The subset of the /agents row model this card renders. */
export type AgentAllCardRow = {
  key: string;
  name: string;
  description: string;
  /** "local" for Cinatra-hosted agents; connector slug for external A2A. */
  host: "local" | string;
  runHref: string;
  /** Scoped npm package name of the agent's listing; null for A2A/unscoped. */
  packageName: string | null;
  /**
   * Full-page marketplace-detail route; null for A2A/unscoped, and null on a
   * per-scope tab (cinatra#2808), whose reader may be a plain member: that
   * route is admin-only, so no link is offered and "More details" opens the
   * ratified detail modal in place instead. `packageName` alone now decides
   * whether the card carries a detail affordance at all.
   */
  detailHref: string | null;
  /**
   * The per-entry SETTINGS control (cinatra#2808, per-scope surfaces S2): the
   * assignment page for this package AT this scope, addressed by #2809's href
   * contract. EXTENDED BY NAME — the /agents "All Agents" tab passes none, so
   * the ratified §IV card ("The right panel drops to a single primary action,
   * Run, plus More details") renders there exactly as before.
   */
  settingsHref?: string | null;
  /**
   * The installed VERSION, already formatted (cinatra#2808). Absent on the
   * /agents card, which the drawing renders "without the version and the
   * Active / Archived indicator".
   */
  version?: string | null;
  /** The install's lifecycle status (cinatra#2808). Absent on /agents, as above. */
  status?: "active" | "locked" | null;
  /**
   * Set when this agent CANNOT run (cinatra#2605) — not installed, or a required
   * dependency is not installed. The primary action slot then carries this
   * truthful CTA instead of Run. Derived server-side; this card renders it and
   * decides nothing.
   */
  unavailable?: {
    reason: string;
    /** `null` when this viewer has no reachable recourse (cinatra#2701) — the
     *  destination is admin-only, so the card states the reason and offers no
     *  button. */
    ctaLabel: string | null;
    ctaHref: string | null;
    ctaAriaLabel: string;
  } | null;
};

export function AgentAllCard({
  row,
  loadDetail,
}: {
  row: AgentAllCardRow;
  /**
   * Fixture-only detail loader override, threaded to AgentDetailModal. Omitted
   * in production (the member-gated loader is the default); the /design-fixtures
   * harness passes a deterministic loader so the modal opens without a session.
   */
  loadDetail?: (packageName: string) => Promise<MarketplaceDetailLoadResult>;
}) {
  const [open, setOpen] = useState(false);
  // §IV vendor byline (cinatra#1528): resolved through the shared resolver via
  // resolveAgentCardVendor — "local" → the genuine "Cinatra" display name; an
  // external A2A agent's connector host slug is a machine identifier and
  // resolves to the explicit missing-vendor state, never the raw slug. This
  // surface never renders `row.host` as a vendor label.
  const vendor = resolveAgentCardVendor({ host: row.host, ref: row.packageName ?? row.key });
  // A scoped listing carries a packageName → the accent panel and "More
  // details" both open the ratified detail modal. External A2A / unscoped
  // agents carry none → Run only, inert accent. The full-page `detailHref` is
  // now only the no-JS fallback where the reader may actually follow it (the
  // admin arm); a member-facing scope tab passes null and still gets the modal.
  const hasDetail = row.packageName != null;

  return (
    <InstalledExtensionCard
      name={row.name}
      accentColor={deriveExtensionAccent(row.key)}
      emblem={extensionKindEmblem("agent")}
      kindIcon={extensionKindEmblem("agent", "size-3.5")}
      kindLabel="Agent"
      vendor={vendor}
      description={row.description || undefined}
      // §IV (cinatra#3227): "The description is capped at three lines."
      descriptionLineClamp={3}
      // `version` / `status` are absent on the /agents "All Agents" card — the
      // ratified §IV card is the Installed-extensions card minus the version and
      // the Active/Archived indicator (cinatra#1007). A per-scope Agents tab
      // (cinatra#2808) passes both, and only that surface renders them.
      version={row.version ?? undefined}
      status={row.status ? <InstalledStatusIndicator status={row.status} /> : undefined}
      accentDetailHref={hasDetail && row.detailHref ? row.detailHref : undefined}
      // The accent panel is a SECOND hit-area for the same modal, and it is one
      // only where it can also be a real anchor — the no-JS fallback the ruling
      // gave it. A member-facing scope card carries no such href, so the panel
      // stays the presentational panel it has always been and "More details"
      // is the affordance.
      onAccentActivate={hasDetail && row.detailHref ? () => setOpen(true) : undefined}
      accentLabel={hasDetail && row.detailHref ? `View details for ${row.name}` : undefined}
      accentInert={row.detailHref == null}
      actions={
        <>
          {row.unavailable && !row.unavailable.ctaHref ? (
            /* cinatra#2701 — same truth, no recourse this viewer can reach:
               the reason is still stated (title + accessible text), the button
               is not offered. */
            <span
              className="text-xs text-muted-foreground"
              title={row.unavailable.reason}
              data-slot="agent-card-unavailable-reason"
            >
              Unavailable
            </span>
          ) : row.unavailable ? (
            /* cinatra#2605 — the agent cannot run (not installed, or a required
               dependency is not installed), so the primary slot carries the
               recourse instead of a Run that would fail. No play icon (it would
               still read as "start a run"); the accessible name carries the full
               reason because the short visible label cannot. */
            <Button asChild size="sm" variant="outline">
              <Link
                href={row.unavailable.ctaHref!}
                aria-label={row.unavailable.ctaAriaLabel}
                title={row.unavailable.reason}
                data-slot="agent-card-unavailable-action"
              >
                {row.unavailable.ctaLabel}
              </Link>
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link href={row.runHref}>
                {/* Solid play icon (fill="currentColor", no outline) — fill-current
                    fills the lucide glyph in place of the settings gear. */}
                <Play
                  data-icon="inline-start"
                  aria-hidden="true"
                  className="fill-current"
                />
                Run
              </Link>
            </Button>
          )}
          {/* The per-entry Settings control (cinatra#2808): the assignment page
              for this package at this scope. Rendered only where the caller
              supplied the href, so the /agents card is unchanged. */}
          {row.settingsHref && (
            <Button asChild size="sm" variant="outline">
              <Link href={row.settingsHref} data-slot="agent-card-settings">
                <Settings data-icon="inline-start" aria-hidden="true" />
                Settings
              </Link>
            </Button>
          )}
          {/* "More details" opens the §V detail modal IN PLACE (owner ruling,
              2026-07-06) — the SAME <MarketplaceDetailModal> the Installed-
              extensions card uses, details-only (no footer/install CTA). Its
              `href` is the full-page detail (no-JS fallback). Rendered only for a
              scoped listing; A2A / unscoped agents show Run only. `open` is
              lifted here so the accent panel opens this very same modal. */}
          {hasDetail && (
            <AgentDetailModal
              name={row.name}
              description={row.description}
              packageName={row.packageName!}
              detailHref={row.detailHref}
              open={open}
              onOpenChange={setOpen}
              loadDetail={loadDetail}
            />
          )}
        </>
      }
    />
  );
}
