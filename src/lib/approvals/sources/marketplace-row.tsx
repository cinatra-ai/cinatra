import "server-only";

import type { ReactNode } from "react";
import Link from "next/link";

import { StatusPill } from "@/components/ui/status-pill";

import { marketplaceStatePill } from "./marketplace-state";

// ---------------------------------------------------------------------------
// Shared presentational shell for a marketplace approval row. Matches the
// agent / workflow row layout (#1044) so every source section reads as one
// surface: a title line (linked title + status pill + optional extra chips), a
// muted meta line, and a right-aligned action / details slot.
//
// The state is drawn as the roster status pill (cinatra#4296, specs/app.html
// V.1): never a Badge, and the pill's own label, never the raw state word.
// A stuck vendor-application repair is a flag on the row, not a state: the
// Failed pill is drawn beside the state pill, and the caller puts the attempt
// count on the meta line.
// ---------------------------------------------------------------------------

export function MarketplaceRowView({
  title,
  href,
  state,
  viewerMayDecide = false,
  repairStuck = false,
  extraBadges,
  meta,
  right,
}: {
  title: string;
  href?: string;
  /** The source-native state token (applied, pending, approved, …). */
  state: string;
  /** True on a moderation row the viewer may decide (Awaiting you). */
  viewerMayDecide?: boolean;
  /** Draws the Failed pill beside the state pill. */
  repairStuck?: boolean;
  extraBadges?: ReactNode;
  meta: ReactNode;
  right: ReactNode;
}) {
  const pill = marketplaceStatePill(state, { viewerMayDecide });
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {href ? (
            <Link href={href} className="truncate font-medium text-foreground hover:text-primary">
              {title}
            </Link>
          ) : (
            <span className="truncate font-medium text-foreground">{title}</span>
          )}
          <StatusPill status={pill.status} glyph={pill.glyph} data-state={state}>
            {pill.label}
          </StatusPill>
          {repairStuck ? (
            <StatusPill status="failed" title="Repair stuck: an administrator must step in.">
              Failed
            </StatusPill>
          ) : null}
          {extraBadges}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{right}</div>
    </div>
  );
}
