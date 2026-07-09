import "server-only";

import type { ReactNode } from "react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";

// ---------------------------------------------------------------------------
// Shared presentational shell for a marketplace approval row. Matches the
// agent / workflow row layout (#1044) so every source section reads as one
// surface: a title line (linked title + status pill + optional extra badges), a
// muted meta line, and a right-aligned action / details slot.
// ---------------------------------------------------------------------------

export type MarketplaceBadgeVariant = "default" | "secondary" | "destructive" | "outline";

export function MarketplaceRowView({
  title,
  href,
  statusLabel,
  statusVariant = "outline",
  extraBadges,
  meta,
  right,
}: {
  title: string;
  href?: string;
  statusLabel: string;
  statusVariant?: MarketplaceBadgeVariant;
  extraBadges?: ReactNode;
  meta: ReactNode;
  right: ReactNode;
}) {
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
          <Badge variant={statusVariant} className="capitalize">
            {statusLabel}
          </Badge>
          {extraBadges}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{meta}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">{right}</div>
    </div>
  );
}
