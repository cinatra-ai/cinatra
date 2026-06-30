import * as React from "react";
import { Button } from "./ui/button";
import { cn } from "./lib/utils";
import {
  ACCENT_PALETTE,
  type ExtensionAccent,
} from "./lib/extension-accent";

/**
 * ExtensionCard — the canonical presentation for an extension instance.
 *
 * One card. Emblem (left) — a fixed type icon or vendor brand logo,
 * wrapped in a white pill so brand colour reads against any ground.
 * Indicator (right) — a live state pill (Connected, Scheduled, Updating…).
 * Background colour — drawn at random from the palette accents at
 * creation time. Persist `accentColor` on the row in DB; do not pick fresh
 * on each render. For not-yet-installed listings, derive a stable accent
 * via `deriveExtensionAccent(name)` from `./lib/extension-accent`.
 *
 * Two render modes:
 *   - Button mode (default): the whole card is a clickable `<button>`.
 *     Used for running-agent / installed-extension lists.
 *   - Shell mode (when `footer`/`description` provided OR
 *     `interactive=false`): renders a `<div>` with the accent chip on top
 *     and a presentation body (description, meta, footer) beneath it. Used
 *     by the marketplace, where each tile carries badges + an
 *     Install/Update/Restore CTA `<form>` that cannot legally nest inside a
 *     `<button>`.
 */

export type { ExtensionAccent };

export type ExtensionIndicator = {
  label: string;
  /** CSS colour string; defaults to `var(--success)`. */
  dotColour?: string;
  /** Small spinner instead of a dot (e.g. "Updating"). */
  spinning?: boolean;
};

export type ExtensionCardProps = {
  name: string;
  accentColor: ExtensionAccent;
  emblem: React.ReactNode;
  indicator?: ExtensionIndicator;
  onClick?: () => void;
  className?: string;
  /** Shell-mode body slots — presence triggers the `<div>` shell. */
  description?: React.ReactNode;
  meta?: React.ReactNode;
  footer?: React.ReactNode;
  /** Replaces the indicator in the chip top-right (e.g. kind + visibility badges). */
  badges?: React.ReactNode;
  /** Force render mode. Defaults to true (button) unless body slots are present. */
  interactive?: boolean;
  /**
   * Banner variant for the SHELL-mode header (no effect in button mode):
   *   - `"chip"` (default) — the §V running-agent chip: emblem-left, indicator/
   *     badges top-right, name BELOW the emblem.
   *   - `"listing"` — the §IV marketplace listing banner: a 46×46 SQUARE icon
   *     tile + the name INSIDE the banner (line-clamp 3), the icon resolving
   *     `iconUrl` → `emblem`. The marketplace storefront opts in explicitly so
   *     no other shell caller is restyled.
   */
  variant?: "chip" | "listing";
  /**
   * Hosted square-icon URL for the `"listing"` variant (marketplace spec §IV).
   * When present the banner renders this image in the 46×46 tile; absent → the
   * `emblem`. Ignored by the `"chip"` variant.
   */
  iconUrl?: string | null;
};

export function ExtensionCard({
  name,
  accentColor,
  emblem,
  indicator,
  onClick,
  className,
  description,
  meta,
  footer,
  badges,
  interactive,
  variant = "chip",
  iconUrl,
}: ExtensionCardProps) {
  const isShell =
    interactive === false ||
    description !== undefined ||
    meta !== undefined ||
    footer !== undefined;

  if (!isShell) {
    return (
      <Button
        type="button"
        variant="ghost"
        onClick={onClick}
        data-slot="extension-card"
        data-accent={accentColor}
        aria-label={name}
        className={cn(
          // Reset the Button base/ghost chrome so this stays the full-bleed
          // card it was as a raw <button>: block layout (not inline-flex
          // centred), auto height, no inner padding/font/whitespace clamp,
          // and no ghost hover background (the card owns its own hover lift).
          // rounded-[var(--radius-card)] (not the rounded-card token) so
          // tailwind-merge recognizes the radius group and deterministically
          // drops the Button base's rounded-lg — same computed radius as
          // rounded-card, but order-independent. Mirrors the app's
          // src/components/extension-card.tsx conversion.
          "block h-auto p-0 text-sm font-normal whitespace-normal hover:bg-transparent hover:text-inherit",
          "group/extension relative w-full overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface-strong text-left transition-all hover:-translate-y-px hover:shadow-strong focus-visible:ring-3 focus-visible:ring-ring/40 outline-none",
          className,
        )}
      >
        <ExtensionCardChip
          name={name}
          accentColor={accentColor}
          emblem={emblem}
          indicator={indicator}
        />
      </Button>
    );
  }

  return (
    <div
      data-slot="extension-card"
      data-accent={accentColor}
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-card border border-line bg-surface",
        className,
      )}
    >
      {variant === "listing" ? (
        <ExtensionCardListingBanner
          name={name}
          accentColor={accentColor}
          emblem={emblem}
          iconUrl={iconUrl}
          badges={badges}
        />
      ) : (
        <ExtensionCardChip
          name={name}
          accentColor={accentColor}
          emblem={emblem}
          indicator={indicator}
          badges={badges}
        />
      )}
      <div className="flex flex-1 flex-col gap-3 bg-surface p-4">
        {description && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
        {footer && <div className="mt-auto">{footer}</div>}
      </div>
    </div>
  );
}

function ExtensionCardChip({
  name,
  accentColor,
  emblem,
  indicator,
  badges,
}: {
  name: string;
  accentColor: ExtensionAccent;
  emblem: React.ReactNode;
  indicator?: ExtensionIndicator;
  badges?: React.ReactNode;
}) {
  const { bg, fg } = ACCENT_PALETTE[accentColor];
  return (
    <div
      className="flex min-h-[150px] flex-col justify-between gap-3 p-[18px]"
      style={{ background: bg, color: fg }}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Emblem badge — white pill, fixed 42px circle */}
        <span
          className="inline-grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-surface-strong shadow-sm"
          style={{ color: bg }}
        >
          {emblem}
        </span>
        {badges ? (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {badges}
          </div>
        ) : indicator ? (
          <Indicator
            label={indicator.label}
            dotColour={indicator.dotColour ?? "var(--success)"}
            spinning={indicator.spinning}
          />
        ) : null}
      </div>
      <div className="font-display text-[20px] font-extrabold italic leading-tight tracking-tight">
        {name}
      </div>
    </div>
  );
}

/**
 * Marketplace listing-card banner (design spec §IV). The coloured banner area
 * (category colour, min-h 96px) lays the 46×46 SQUARE icon tile and the
 * human-readable name out side by side — the name lives INSIDE the banner
 * (Archivo italic-800, 18px, line-clamp 3), not beneath the emblem (that is the
 * §V running-agent chip). The icon tile resolves a fallback chain: a hosted
 * square icon URL → else the kind/vendor `emblem` (the caller resolves
 * icon → vendor-logo → kind-emblem before passing `iconUrl`/`emblem`).
 *
 * `badges` (kind + commerce) overlay the top-right corner so the icon+name row
 * stays the §IV layout. Mirrors the app's src/components/extension-card.tsx.
 */
function ExtensionCardListingBanner({
  name,
  accentColor,
  emblem,
  iconUrl,
  badges,
}: {
  name: string;
  accentColor: ExtensionAccent;
  emblem: React.ReactNode;
  iconUrl?: string | null;
  badges?: React.ReactNode;
}) {
  const { bg, fg } = ACCENT_PALETTE[accentColor];
  return (
    <div
      data-slot="extension-card-banner"
      className="relative flex min-h-[96px] items-center gap-3 p-[14px]"
      style={{ background: bg, color: fg }}
    >
      <span
        data-slot="extension-card-icon"
        className="grid h-[46px] w-[46px] shrink-0 place-items-center overflow-hidden rounded-[11px] bg-surface-strong shadow-sm"
        style={{ color: bg }}
      >
        {iconUrl ? (
          // An arbitrary remote marketplace asset host; a sanitized hosted asset
          // (rasterized, never a raw SVG blob). Not a build-time-known image.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={iconUrl}
            alt=""
            className="h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        ) : (
          emblem
        )}
      </span>
      <div
        data-slot="extension-card-name"
        className={cn(
          "line-clamp-3 min-w-0 font-display text-[18px] font-extrabold italic leading-[1.12] tracking-[-0.012em]",
          // Reserve room for the top-right badge overlay so a long, line-clamped
          // name never runs underneath the badges.
          badges && "pr-20",
        )}
      >
        {name}
      </div>
      {badges && (
        <div className="absolute right-[14px] top-[14px] flex flex-wrap items-center justify-end gap-1.5">
          {badges}
        </div>
      )}
    </div>
  );
}

function Indicator({
  label,
  dotColour,
  spinning,
}: {
  label: string;
  dotColour: string;
  spinning?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-strong px-2.5 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.14em] text-foreground shadow-sm">
      {spinning ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-2.5 w-2.5 animate-spin"
          style={{ color: dotColour }}
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      ) : (
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: dotColour }}
        />
      )}
      {label}
    </span>
  );
}
