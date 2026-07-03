import type { ReactNode } from "react";
// Extended tailwind-merge (same reason as extension-card.tsx): the default app
// cn strips the custom design-token size utilities whenever a text-COLOR class
// follows in the same merge.
import { cn } from "@cinatra-ai/sdk-ui/lib/utils";
import {
  ExtensionCardListingBanner,
  type ExtensionAccent,
} from "@/components/extension-card";
import { ACCENT_PALETTE } from "@/lib/extension-accent";

/**
 * InstalledExtensionCard — the design system's "Installed extensions" card
 * (published design system, "Installed extensions" section): ONE horizontal
 * card per installed extension, split three ways.
 *
 *   1. LEFT — the ListingCard mark (46px icon tile + italic display name on
 *      the extension's accent ground), reused verbatim from
 *      `ExtensionCardListingBanner` at listing-card width (340px).
 *   2. MIDDLE — the "{Kind} by {Vendor}" byline (small kind glyph tinted with
 *      the accent), the description, then the mono version with the lifecycle
 *      status indicator beside it.
 *   3. RIGHT — a hairline-divided actions panel (Settings primary, More
 *      details, plus any management actions the caller passes).
 *
 * Server-renderable (no client hooks); all interactivity lives in the slots
 * the caller provides (links / server-action forms). Colors ride the shared
 * `ACCENT_PALETTE` inline styles + semantic tokens; type rides the named
 * type-scale tokens — no arbitrary color/type class values (cinatra#803).
 * On narrow screens the panels stack: mark on top (the §IV banner layout),
 * body, then the actions panel divided by a top hairline.
 */
export type InstalledExtensionCardProps = {
  name: string;
  accentColor: ExtensionAccent;
  /** Kind (or vendor-brand) emblem for the icon tile; `iconUrl` wins when set. */
  emblem: ReactNode;
  iconUrl?: string | null;
  /** Small kind glyph for the byline (tinted with the accent color). */
  kindIcon?: ReactNode;
  kindLabel: string;
  vendor?: string | null;
  description?: string | null;
  /** Already-formatted version text (e.g. "v1.2.0" formatting is the caller's). */
  version?: string | null;
  /** Lifecycle status indicator (+ any visibility/risk badges) beside the version. */
  status?: ReactNode;
  /** Right-panel actions, top to bottom (Settings, More details, management). */
  actions?: ReactNode;
  className?: string;
};

export function InstalledExtensionCard({
  name,
  accentColor,
  emblem,
  iconUrl,
  kindIcon,
  kindLabel,
  vendor,
  description,
  version,
  status,
  actions,
  className,
}: InstalledExtensionCardProps) {
  const { bg } = ACCENT_PALETTE[accentColor];
  return (
    <div
      data-slot="installed-extension-card"
      data-accent={accentColor}
      className={cn(
        "flex flex-col overflow-hidden rounded-card border border-line bg-surface-strong shadow-sm md:flex-row md:items-stretch",
        className,
      )}
    >
      {/* LEFT — the ListingCard mark at listing-card width. */}
      <ExtensionCardListingBanner
        name={name}
        accentColor={accentColor}
        emblem={emblem}
        iconUrl={iconUrl}
        className="p-4 md:w-[340px] md:shrink-0"
      />

      {/* MIDDLE — byline, description, version + status. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 px-[18px] py-[15px]">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {kindIcon && (
            <span aria-hidden className="inline-flex shrink-0" style={{ color: bg }}>
              {kindIcon}
            </span>
          )}
          <span className="truncate">
            <span className="font-medium text-foreground">{kindLabel}</span>
            {vendor && (
              <>
                {" by "}
                <span className="font-medium text-foreground">{vendor}</span>
              </>
            )}
          </span>
        </div>
        {description && (
          <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {version && (
            <span className="font-mono text-xs text-muted-foreground">{version}</span>
          )}
          {status}
        </div>
      </div>

      {/* RIGHT — hairline-divided actions panel. */}
      {actions && (
        <div className="flex flex-col items-stretch justify-center gap-2 border-t border-line p-4 md:w-[176px] md:shrink-0 md:border-l md:border-t-0">
          {actions}
        </div>
      )}
    </div>
  );
}
