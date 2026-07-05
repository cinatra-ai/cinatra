import type { ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { CircleCheck, Star } from "lucide-react";

import { ExtensionCardListingBanner } from "@/components/extension-card";
import { ExtensionCompatBadge } from "@/components/extension-compat-badge";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { ACCENT_PALETTE, type ExtensionAccent } from "@/lib/extension-accent";
import { safeHttpUrl } from "@/lib/marketplace-detail-view";
import { cn } from "@/lib/utils";
import type { MarketplaceCardData } from "./marketplace-card-model";
import { resolveCardPriceLabel } from "./marketplace-card-model";

// ---------------------------------------------------------------------------
// MarketplaceListingCard — the §IV "Extensions" ListingCard (cinatra#988).
//
// The full card anatomy of the pinned design spec §IV (docs@b35fdf4), in spec
// order:
//   1. Banner: ONLY the 46×46 icon tile + the name (line-clamp 3). Kind and
//      commerce are NOT banner badges — kind lives in the publisher line,
//      commerce in the price row.
//   2. Body top block (min-height 86px): the 3-line-clamped description, then
//      the "{Type} by {Vendor}" publisher line — 13px kind emblem in the
//      accent colour, type in ink, vendor as a link in the action colour, and
//      the circled-check VERIFIED mark when the catalog carried a vendor.
//   3. Centred column: the price row ("Free" / "Free, Open Source" / price,
//      Archivo 700 16px ink), the install CTA, the "More details" link.
//   4. Footer meta, two columns: LEFT stars + average + (count) with the
//      install count beneath; RIGHT the compat verdict + "Updated N ago",
//      right-aligned.
//
// PURE presentation: the interactive controls (the six-state install CTA and
// the "More details" modal trigger) are supplied by the caller as slots —
// one source of truth for the card anatomy.
// ---------------------------------------------------------------------------

/** First non-null link of the icon fallback chain: icon → vendor logo. */
export function resolveCardIconUrl(card: MarketplaceCardData): string | null {
  return card.iconUrl ?? card.vendorLogoUrl ?? null;
}

/** "Updated N ago" freshness label, or null for a missing/invalid date. */
export function freshnessLabel(freshnessAt: string | null): string | null {
  if (!freshnessAt) return null;
  const d = new Date(freshnessAt);
  if (isNaN(d.getTime())) return null;
  return `Updated ${formatDistanceToNow(d, { addSuffix: true })}`;
}

/**
 * Compact install-count label for the meta row (design spec §IV: "2.1k
 * installations"). A null/absent count (older marketplace builds omit the
 * field) renders no line. Singular/plural agree; thousands collapse to a "k"
 * suffix (one decimal, trailing-zero trimmed: 2100 → "2.1k", 2000 → "2k").
 */
export function installCountLabel(count: number | null): string | null {
  if (count === null) return null;
  if (count < 1000) {
    return `${count} ${count === 1 ? "installation" : "installations"}`;
  }
  const thousands = count / 1000;
  // One decimal, but drop a trailing ".0" (2000 → "2k", 2150 → "2.2k").
  const rounded = Math.round(thousands * 10) / 10;
  const text = Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
  return `${text}k installations`;
}

/**
 * Publisher fallback when the catalog entry carries no vendor block: the
 * package scope IS the vendor namespace on the marketplace (e.g.
 * "@cinatra-ai/…" → "cinatra-ai"), so the line still reads "{Type} by
 * {scope}" instead of dropping the publisher entirely. No VERIFIED mark in
 * this case — a derived namespace is not a verified vendor identity.
 */
function scopeFromPackageName(packageName: string): string {
  const slash = packageName.indexOf("/");
  const scope = slash > 0 ? packageName.slice(0, slash) : packageName;
  return scope.replace(/^@/, "");
}

/**
 * Stars + numeric average + (count) — the LEFT meta column's rating row
 * (spec §IV L477). Stars fill to the rounded average; colours stay on the
 * semantic ink/muted tokens (the app's star treatment everywhere, incl. the
 * detail modal) rather than the spec drawing's raw gold hex, which the
 * design-token lint deliberately bans outside the token files.
 */
function RatingRow({
  rating,
}: {
  rating: NonNullable<MarketplaceCardData["rating"]>;
}) {
  const filled = Math.round(rating.average);
  return (
    <span
      className="flex items-center gap-1.5 whitespace-nowrap"
      aria-label={`Rated ${rating.average} out of 5`}
    >
      <span className="flex gap-px text-foreground">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            aria-hidden="true"
            className={cn("size-3", i <= filled ? "fill-current" : "opacity-40")}
          />
        ))}
      </span>
      <span className="font-mono text-badge-xs font-bold text-foreground">
        {rating.average.toFixed(1)}
      </span>
      <span className="font-mono text-badge-xs text-muted-foreground">
        ({rating.count})
      </span>
    </span>
  );
}

/**
 * The "{Type} by {Vendor}" publisher line (spec §IV L468): 13px kind emblem in
 * the accent colour, the type label in ink, the vendor as a link in the action
 * colour (scheme-guarded — a non-http(s) store URL degrades to plain text),
 * and the circled-check VERIFIED mark for a catalog-carried vendor.
 */
function PublisherLine({
  card,
  accentColor,
}: {
  card: MarketplaceCardData;
  accentColor: ExtensionAccent;
}) {
  const { bg } = ACCENT_PALETTE[accentColor];
  const vendorName = card.vendor?.name ?? scopeFromPackageName(card.packageName);
  const storeUrl = safeHttpUrl(card.vendor?.storeUrl);
  return (
    <div
      data-slot="extension-card-publisher"
      className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-xs text-muted-foreground"
    >
      <span className="shrink-0" style={{ color: bg }} aria-hidden="true">
        {extensionKindEmblem(card.kindSlug, "size-[13px]")}
      </span>
      <span className="overflow-hidden text-ellipsis">
        <span className="text-foreground">{card.kindLabel}</span>
        {" by "}
        {storeUrl ? (
          <Link
            href={storeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-primary hover:underline"
          >
            {vendorName}
          </Link>
        ) : (
          <span className="font-semibold text-primary">{vendorName}</span>
        )}
      </span>
      {card.vendor && (
        // The circled-check VERIFIED mark — the pinned spec drawing (§IV L468)
        // renders the check alone, with no visible "VERIFIED" copy; the
        // accessible name + native tooltip carry the meaning.
        <span
          data-slot="extension-card-verified"
          className="inline-flex shrink-0"
          title="Verified vendor"
        >
          <CircleCheck aria-label="Verified vendor" className="size-3 text-primary" />
        </span>
      )}
    </div>
  );
}

export type MarketplaceListingCardProps = {
  card: MarketplaceCardData;
  accentColor: ExtensionAccent;
  /**
   * The six-state install CTA control (Install now / Installed / Update now /
   * Restore / Installing… / greyed Incompatible) — supplied by the caller; the
   * live screen binds server-action forms.
   */
  ctaControl: ReactNode;
  /** The centred underlined "More details" control (modal trigger). */
  detailsControl: ReactNode;
  className?: string;
};

export function MarketplaceListingCard({
  card,
  accentColor,
  ctaControl,
  detailsControl,
  className,
}: MarketplaceListingCardProps) {
  const freshness = freshnessLabel(card.freshnessAt);
  const installs = installCountLabel(card.installCount);
  const price = resolveCardPriceLabel(card.badge);

  return (
    <div
      data-slot="extension-card"
      data-accent={accentColor}
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface-strong",
        className,
      )}
    >
      {/* §IV banner: ONLY the icon tile + name — no badge overlay. */}
      <ExtensionCardListingBanner
        name={card.displayName}
        accentColor={accentColor}
        emblem={extensionKindEmblem(card.kindSlug)}
        iconUrl={resolveCardIconUrl(card)}
      />
      <div className="flex flex-1 flex-col px-[14px] py-3">
        {/* Description block — min-height 86px so card bodies align across the
            row even when descriptions differ (spec §IV L466). */}
        <div className="min-h-[86px]">
          {card.description && (
            <p className="mb-2 line-clamp-3 text-sm leading-normal text-muted-foreground">
              {card.description}
            </p>
          )}
          <PublisherLine card={card} accentColor={accentColor} />
        </div>
        {/* Centred price + CTA + details column (spec §IV L470–474). */}
        <div className="mt-3 flex flex-col items-center gap-2">
          {price && (
            <div
              data-slot="extension-card-price"
              className="text-center font-display text-base font-bold text-foreground"
            >
              {price}
            </div>
          )}
          {ctaControl}
          {detailsControl}
        </div>
        {/* Two-column footer meta (spec §IV L475–483): rating + installs LEFT,
            compat + freshness RIGHT (right-aligned). */}
        <div
          data-slot="extension-card-meta"
          className="mt-auto flex items-start justify-between gap-3.5 pt-3.5"
        >
          <div className="grid gap-1">
            {card.rating && <RatingRow rating={card.rating} />}
            {installs && (
              <span className="whitespace-nowrap font-mono text-badge-xs text-muted-foreground">
                {installs}
              </span>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {/* 3-state in-instance ABI compatibility verdict, derived locally
                from the catalog's declared sdkAbiRange (absent → neutral
                "Unknown", never green). Red-triangle Incompatible treatment
                lives in ExtensionCompatBadge (destructive variant). */}
            <ExtensionCompatBadge sdkAbiRange={card.sdkAbiRange} />
            {freshness && (
              <span className="whitespace-nowrap font-mono text-badge-xs text-muted-foreground">
                {freshness}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
