import type { ReactNode } from "react";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import { Check, CircleHelp, Star, TriangleAlert } from "lucide-react";

import { ExtensionCardListingBanner } from "@/components/extension-card";
import { MarketplaceCardIcon } from "@/components/extension-card-icon-image";
import { extensionKindEmblem } from "@/components/extension-kind-emblem";
import { type ExtensionAccent } from "@/lib/extension-accent";
import { deriveExtensionCompatState } from "@/lib/extension-compat-badge";
import { safeHttpUrl } from "@/lib/marketplace-detail-view";
import {
  resolveVendorPresentation,
  VENDOR_BY_CONNECTIVE,
  VENDOR_MISSING_LABEL,
} from "@/lib/vendor-presentation";
import { cn } from "@/lib/utils";
import type { MarketplaceCardData } from "./marketplace-card-model";
import { resolveCardPriceLabel } from "./marketplace-card-model";

// ---------------------------------------------------------------------------
// MarketplaceListingCard — the §IV "Extensions" ListingCard (cinatra#988).
//
// The full card anatomy of the current ratified card spec §I, in spec order:
//   1. Banner: the 46×46 icon tile beside a name (line-clamp 2) + the "{Kind}
//      by {Vendor}" byline directly beneath the name, ALL on the coloured
//      ground — the byline recoloured white to match the name (0.5.0 moved it
//      here off the body). The 13px kind emblem, kind label and vendor link
//      all read white. Commerce lives in the price row, not a banner badge.
//   2. Body top block (min-height 62px): the 3-line-clamped description only.
//   3. Centred column: the price row ("Free" / "Free, Open Source" / price,
//      Archivo 700 16px ink), then the install CTA and the "More details"
//      link SIDE BY SIDE on one row (spec §I, cinatra#2363), details to the
//      right of the CTA, wrapping only when the pair does not fit.
//   4. Footer meta, two columns: LEFT stars + average + (count) with the
//      install count beneath; RIGHT the compat verdict + "Updated N ago",
//      right-aligned.
//
// PURE presentation: the interactive controls (the six-state install CTA and
// the "More details" modal trigger) are supplied by the caller as slots —
// one source of truth for the card anatomy.
// ---------------------------------------------------------------------------

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
 * Stars + numeric average + (count) — the LEFT meta column's rating row (spec
 * §IV L477: filled `#f5a623` amber / empty `#d0cbbd` warm-grey). Stars fill to
 * the rounded average, using the named `text-rating-star` /
 * `text-rating-star-muted` tokens (globals.css `@theme inline`, cinatra#1003)
 * — the SAME dedicated rating-colour tokens the §V detail-modal review stars
 * already use (marketplace-detail-modal.tsx), not the semantic ink/muted
 * tokens (which read as plain grey, not the spec's amber rating colour).
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
      <span className="flex gap-px">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            aria-hidden="true"
            // Plain concat, not cn(): `text-rating-star*` are custom color
            // utilities tailwind-merge doesn't recognize as a "text-*" group,
            // so cn() would keep both classes anyway — concat matches the
            // §V modal's own rating-star treatment for the identical reason.
            className={"size-3 fill-current " + (i <= filled ? "text-rating-star" : "text-rating-star-muted")}
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
 * The "{Kind} by {Vendor}" publisher line (current ratified card spec §I): rendered
 * INSIDE the coloured banner, directly beneath the name (0.5.0 relocated it
 * off the body block). Everything reads WHITE on the category ground — the
 * kind emblem, the kind label and the vendor all inherit the banner's
 * `currentColor` (the banner sets the white `fg`), so the byline recolours to
 * match the name.
 *
 * The vendor label comes ONLY from `resolveVendorPresentation` (cinatra#1528) —
 * this surface never derives a label from the package scope or a slug. A
 * `known` vendor renders its display name (a link out to its scheme-guarded
 * marketplace store when a valid `storeUrl` is present, plain text otherwise);
 * a `missing` vendor renders the localized placeholder as PLAIN, unlinked text.
 * The vendor label carries a native always-on `title=` (cinatra#2363) so a
 * truncated/ellipsised long name is still readable on hover — the unclipped
 * text stays in the accessibility tree regardless.
 *
 * The checkmark this byline used to render for a `known` vendor is REMOVED
 * (cinatra#2363/#2362): it fired on `vendor.kind === "known"` — i.e. "the
 * catalog carried a vendor display name" — never any real verification field
 * (none exists in the model), so its `title="Verified vendor"` was actively
 * misleading. Removal loses no information in-app.
 */
function PublisherLine({ card }: { card: MarketplaceCardData }) {
  const vendor = resolveVendorPresentation(
    { name: card.vendor?.name, storeUrl: card.vendor?.storeUrl },
    { surface: "marketplace-listing-card", ref: card.packageName },
  );
  const storeUrl = vendor.kind === "known" ? safeHttpUrl(vendor.storeUrl) : null;
  const vendorLabel = vendor.kind === "known" ? vendor.displayName : VENDOR_MISSING_LABEL;
  return (
    <div
      data-slot="extension-card-publisher"
      data-vendor-state={vendor.kind}
      // On the coloured banner: `text-current` so the kind emblem, kind label
      // and vendor label all inherit the banner's white (or archived-muted)
      // ground colour. `text-xs` is the app's sanctioned byline size
      // (named-token/standard-size gate).
      className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs leading-tight text-current"
    >
      <span className="shrink-0 text-current" aria-hidden="true">
        {extensionKindEmblem(card.kindSlug, "size-[13px]")}
      </span>
      <span className="overflow-hidden text-ellipsis">
        <span>{card.kindLabel}</span>
        {` ${VENDOR_BY_CONNECTIVE} `}
        {storeUrl ? (
          <Link
            href={storeUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-slot="extension-card-vendor-label"
            className="font-semibold text-current hover:underline"
            title={vendorLabel}
          >
            {vendorLabel}
          </Link>
        ) : (
          <span
            data-slot="extension-card-vendor-label"
            className="font-semibold text-current"
            title={vendorLabel}
          >
            {vendorLabel}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * The RIGHT footer-meta compat verdict (spec §IV L481 "Compatible" / L631
 * "Incompatible") — a PLAIN mono-10px row, icon + label, right-aligned. NEVER
 * a badge/pill: the pinned drawing renders this identically to "Updated N ago"
 * beneath it, just a coloured icon + text, no chrome (cinatra#1003 — the same
 * rule the §V detail-modal fix already applied to its own "Compatible up to"
 * row, #995). Compatible: small check in the accent-link colour, label in
 * ink. Incompatible: warning triangle + label both in the destructive red —
 * exact spec colours. Unknown (no declared ABI range) has no drawing example;
 * it keeps the same plain anatomy in the neutral muted tone (never green).
 */
function CompatMeta({ sdkAbiRange }: { sdkAbiRange: string | null | undefined }) {
  const state = deriveExtensionCompatState(sdkAbiRange);
  const Icon = state === "compatible" ? Check : state === "incompatible" ? TriangleAlert : CircleHelp;
  const label = state === "compatible" ? "Compatible" : state === "incompatible" ? "Incompatible" : "Compatibility unknown";
  const textColor =
    state === "incompatible" ? "text-destructive" : state === "unknown" ? "text-muted-foreground" : "text-foreground";
  return (
    <span
      data-slot="extension-card-compat"
      data-compat-state={state}
      // Plain concat, not cn(): the app's plain tailwind-merge `cn` (imported
      // above from @/lib/utils, not the sdk-ui EXTENDED merge) does not know
      // `text-badge-xs` is a font-SIZE token, not a color — merging it with a
      // text-color class in the same cn() call silently drops `text-badge-xs`
      // (verified: `twMerge("font-mono text-badge-xs", "text-foreground")` →
      // `"font-mono text-foreground"`). Same trap `extension-card.tsx` and
      // RatingRow above already route around; codex-caught (cinatra#1003).
      className={"flex items-center gap-1 whitespace-nowrap font-mono text-badge-xs " + textColor}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-[11px]", state === "compatible" && "text-primary")}
      />
      {label}
    </span>
  );
}

/**
 * The SPEC-PINNED card block size (design spec §I.1: "recorded here as a spec
 * constant so a card's row in the `grid-auto-rows: 1fr` listing grid never
 * grows or shrinks when the panel opens or closes: 299px at md / lg / xl
 * alike — the card face is a single fixed height").
 *
 * Applied as a min-block-size to BOTH faces, which is what makes the
 * open/close invariant unconditional rather than incidental. `auto-rows-fr`
 * distributes free space but derives each track's BASE size from its content,
 * so `h-full` alone only holds the invariant while some OTHER card in the row
 * is at least as tall: filter the grid down to a single card and the install
 * face — whose content is materially shorter than a listing body — would
 * shrink its own track on open and grow it again on close. A floor shared by
 * the two faces removes that case entirely, with no runtime measurement and
 * nothing to re-resolve at a breakpoint. Above the floor the faces still
 * stretch together (`h-full`), so a taller row keeps both in lockstep.
 */
const CARD_BLOCK_SIZE = "min-h-[299px]";

/**
 * MarketplaceListingCardInstallFace — the §I.1 in-card install face
 * (cinatra#2373).
 *
 * The SAME card shell as the idle listing card and the SAME header band (icon
 * tile, name, byline) — spec §I.1: "The header band — icon, name, byline —
 * carries over unchanged; only the lower region swaps." The body slot is the
 * shared `ExtensionInstallScopePanel`; the header's top-right corner carries
 * the close ✕ through the banner's own badge overlay.
 *
 * GEOMETRY: the same box as the idle card — the shared `CARD_BLOCK_SIZE` floor
 * plus `h-full` inside the same 1fr grid track, so the track can neither shrink
 * nor grow across the swap. `min-h-0` runs the whole flex chain so the panel's
 * middle region — and only it — absorbs any overflow.
 */
export function MarketplaceListingCardInstallFace({
  card,
  accentColor,
  closeControl,
  children,
  className,
}: {
  card: MarketplaceCardData;
  accentColor: ExtensionAccent;
  /** The header ✕ — rendered in the banner's top-right badge overlay. */
  closeControl: ReactNode;
  /** The panel body (shared ExtensionInstallScopePanel). */
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="extension-card"
      // Conformance-contract root id for the `extension-install-panel` surface
      // (cinatra#985 testid-contract.json). The idle face keeps
      // `extension-listing-card` — exactly one face is ever mounted, so the two
      // roots never coexist for one extension.
      data-testid="extension-install-panel"
      data-kind={card.kindSlug}
      data-accent={accentColor}
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-line bg-surface-strong",
        CARD_BLOCK_SIZE,
        className,
      )}
    >
      {/* The banner is rendered with the IDENTICAL props the idle face passes —
          no `badges` slot, because that slot reserves `pr-20` on the name and
          would re-wrap a long title between the two faces. The ✕ is overlaid
          instead (spec §I.1: 10px from the header's top-right corner), so the
          header band is byte-identical across the swap. */}
      <div className="relative flex-none">
        <ExtensionCardListingBanner
          name={card.displayName}
          accentColor={accentColor}
          emblem={extensionKindEmblem(card.kindSlug)}
          iconRender={
            <MarketplaceCardIcon
              card={card}
              kindEmblem={extensionKindEmblem(card.kindSlug)}
            />
          }
          byline={<PublisherLine card={card} />}
        />
        <div className="absolute top-2.5 right-2.5">{closeControl}</div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-[14px] py-3">
        {children}
      </div>
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
  /**
   * The resolved six-state CTA identity (`MarketplaceCardCta["state"]`),
   * surfaced as `data-cta-state` on the CTA slot for the design-conformance
   * functional-acceptance suite (cinatra#985 — stable data-testid contract,
   * tests/e2e/design/conformance/testid-contract.json). Renaming the contract
   * attributes below is a BREAKING change to that suite by design.
   */
  ctaState?: string;
  className?: string;
};

export function MarketplaceListingCard({
  card,
  accentColor,
  ctaControl,
  detailsControl,
  ctaState,
  className,
}: MarketplaceListingCardProps) {
  const freshness = freshnessLabel(card.freshnessAt);
  const installs = installCountLabel(card.installCount);
  const price = resolveCardPriceLabel(card.badge);

  return (
    <div
      data-slot="extension-card"
      // Conformance-contract root id + kind binding (cinatra#985): the
      // functional-acceptance suite keys the extension-listing-card-* surfaces
      // on these attributes (tests/e2e/design/conformance/testid-contract.json).
      data-testid="extension-listing-card"
      data-kind={card.kindSlug}
      data-accent={accentColor}
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface-strong",
        // Shared with the install face — the open/close geometry invariant.
        CARD_BLOCK_SIZE,
        className,
      )}
    >
      {/* 0.5.0 §I banner: icon tile + name + the "{Kind} by {Vendor}" byline
          beneath the name, all on the coloured ground (byline recoloured white). */}
      <ExtensionCardListingBanner
        name={card.displayName}
        accentColor={accentColor}
        emblem={extensionKindEmblem(card.kindSlug)}
        // cinatra#1325: the card icon resolves the SAME chain `/connectors`
        // uses — manifest.logo (cinatra.logo) → client icon map → catalog
        // icon_url → vendor logo → kind emblem — so a connector card shows the
        // connector's real logo, not the generic kind emblem. The order lives
        // in the pure `resolveCardIconChain`; the node tiers resolve in the
        // client `MarketplaceCardIcon`.
        iconRender={
          <MarketplaceCardIcon
            card={card}
            kindEmblem={extensionKindEmblem(card.kindSlug)}
          />
        }
        byline={<PublisherLine card={card} />}
      />
      <div className="flex flex-1 flex-col px-[14px] py-3">
        {/* Description block — reserves 62px (0.5.0 §I: was 86) so card bodies
            align across the row even when descriptions differ; the byline no
            longer lives here (it moved into the banner). */}
        <div className="min-h-[62px]">
          {card.description && (
            <p className="line-clamp-3 text-sm leading-normal text-muted-foreground">
              {card.description}
            </p>
          )}
        </div>
        {/* Centred price + CTA/details column (current ratified card spec §I). The price
            keeps its own line; the CTA and "More details" render as a single
            row beneath it (cinatra#2363) — details to the RIGHT of the CTA,
            wrapping only when the pair does not fit the card body width. */}
        <div className="mt-3 flex flex-col items-center gap-2">
          {price && (
            <div
              data-slot="extension-card-price"
              className="text-center font-display text-base font-bold text-foreground"
            >
              {price}
            </div>
          )}
          <div className="flex min-w-0 flex-row flex-wrap items-center justify-center gap-2">
            {/* Conformance-contract CTA slot (cinatra#985): `display: contents`
                so the wrapper adds ZERO layout impact while giving the
                functional-acceptance suite a stable hook + the resolved
                six-state identity. */}
            <div data-testid="extension-card-cta" data-cta-state={ctaState} className="contents">
              {ctaControl}
            </div>
            {detailsControl}
          </div>
        </div>
        {/* Two-column footer meta (spec §IV L475–483): rating + installs LEFT,
            compat + freshness RIGHT (right-aligned).

            `flex-wrap` is the row's FIT STRATEGY, and it is load-bearing
            (cinatra#2409): every child here is `whitespace-nowrap`, the left
            column is a grid (min-width:auto — it cannot shrink) and the right
            column is `shrink-0` by design (squeezing a nowrap verdict would
            clip it just the same). Without a wrap allowance the row's
            INTRINSIC width — the widest rating row beside the widest of the
            compat verdict / "Updated N ago" — simply exceeds the card body at
            the widths this card actually renders at, and the card root's
            `overflow-hidden` silently slices the right column: "Compatibility
            unknown" and the freshness line lost their tails. The pinned
            drawing fits only because it is drawn at a wider card.

            So: the two columns stay side by side WHENEVER they fit (the
            drawn arrangement is unchanged at the drawn width), and the right
            column drops to its own line — still right-aligned, via `ml-auto`,
            which also does the `justify-between` job on the one-line path —
            rather than overflow the clip box. This is the SAME "one line when
            it fits, wrap otherwise" contract the CTA + "More details" pair
            above already carries (cinatra#2363), for the same reason: a
            guaranteed single line is impossible with nowrap content at the
            narrowest real card width, and a wrapped row still reads, while a
            clipped one does not. */}
        <div
          data-slot="extension-card-meta"
          className="mt-auto flex flex-wrap items-start justify-between gap-x-3.5 gap-y-2 pt-3.5"
        >
          <div className="grid gap-1">
            {card.rating && <RatingRow rating={card.rating} />}
            {installs && (
              <span className="whitespace-nowrap font-mono text-badge-xs text-muted-foreground">
                {installs}
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 flex-col items-end gap-1">
            {/* 3-state in-instance ABI compatibility verdict, derived locally
                from the catalog's declared sdkAbiRange (absent → neutral
                "Unknown", never green) — a PLAIN meta row (spec §IV L481/
                L631), not a badge; see CompatMeta above. */}
            <CompatMeta sdkAbiRange={card.sdkAbiRange} />
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
