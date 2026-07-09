"use client";

// ---------------------------------------------------------------------------
// AgentAllCard — one card on the /agents "All Agents" picker (cinatra#1121).
//
// Wraps the shared <InstalledExtensionCard> (the published design-system
// Installed-extensions card, agent variant: coloured accent panel + byline +
// two-line description, Run + "More details", no version/status row) and lifts
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
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InstalledExtensionCard } from "@/components/extensions/installed-extension-card";
import { AgentDetailModal } from "@/components/extensions/agent-detail-modal";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { deriveExtensionAccent } from "@/lib/extension-accent";
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
  /** Full-page marketplace-detail route; null for A2A/unscoped (in lockstep). */
  detailHref: string | null;
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
  const vendor = row.host === "local" ? "Cinatra" : row.host;
  // A scoped listing carries both packageName and detailHref (in lockstep) → the
  // accent panel and "More details" both open the §V modal. External A2A /
  // unscoped agents carry neither → Run only, inert accent.
  const hasDetail = row.detailHref != null && row.packageName != null;

  return (
    <InstalledExtensionCard
      name={row.name}
      accentColor={deriveExtensionAccent(row.key)}
      emblem={extensionKindEmblem("agent")}
      kindIcon={extensionKindEmblem("agent", "size-3.5")}
      kindLabel="Agent"
      vendor={vendor}
      description={row.description || undefined}
      descriptionLineClamp={2}
      // No `version` / `status` — the Agent card is the Installed-extensions
      // card minus the version + Active/Archived indicator (cinatra#1007).
      accentDetailHref={hasDetail ? row.detailHref! : undefined}
      onAccentActivate={hasDetail ? () => setOpen(true) : undefined}
      accentLabel={hasDetail ? `View details for ${row.name}` : undefined}
      accentInert={!hasDetail}
      actions={
        <>
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
              detailHref={row.detailHref!}
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
