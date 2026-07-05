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
  /** Already-formatted version text (the v-prefixed formatting is the caller's). */
  version?: string | null;
  /**
   * Lifecycle status indicator beside the version — the §VI spec line carries
   * ONLY the mono version + this indicator (cinatra#948 reopen, gap 3).
   */
  status?: ReactNode;
  /**
   * Operational chips (visibility / required / risk …) — deliberately OFF the
   * §VI spec version line, rendered as a subdued row beneath it. A documented
   * operational-necessity addition to the drawing (the reopen keeps the chips
   * but moves them out of the spec line).
   */
  chips?: ReactNode;
  /** Right-panel actions, top to bottom (Settings, More details, management). */
  actions?: ReactNode;
  /**
   * Archived / fully-greyed §VI treatment (cinatra#957): the accent ground
   * desaturates to light grey, the logo tile inks muted, and every text /
   * status / action zone renders muted grey. Active cards keep their
   * category colour.
   */
  archived?: boolean;
  className?: string;
};

/**
 * §VI "Installed extensions" status indicator (published design system §VI
 * drawing + prose L902: "the pinned `--font-mono` version with its
 * Active/Archived status DOT"). A bare 7px dot + a mono, uppercase,
 * letter-spaced label — NOT the §VII `StatusPill` (whose own contract is
 * "an icon on the left — never a bare dot", the opposite treatment). Active
 * and `locked` (a system extension is live) read green; archived reads muted.
 * This is the §VI-specific indicator the drawing calls for; the general
 * `LifecycleBadge`/`StatusPill` stays the §VII list/table renderer.
 */
export function InstalledStatusIndicator({
  status,
}: {
  status: "active" | "locked" | "archived";
}) {
  const archived = status === "archived";
  const label = archived ? "Archived" : status === "locked" ? "Locked" : "Active";
  return (
    <span
      data-slot="installed-status-indicator"
      data-status={status}
      className={cn(
        // §VI status label = the canonical badge-2xs kicker style (9.5px mono,
        // uppercase, the design-system badge letter-spacing) — named tokens per
        // the ui-design-system gate; no arbitrary text-[]/tracking-[].
        "inline-flex items-center gap-1.5 font-mono text-badge-2xs font-bold uppercase",
        archived ? "text-muted-foreground" : "text-success",
      )}
      title={
        status === "locked"
          ? "System extension — always active; cannot be archived or uninstalled."
          : undefined
      }
    >
      <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-current" />
      {label}
    </span>
  );
}

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
  chips,
  actions,
  archived = false,
  className,
}: InstalledExtensionCardProps) {
  const { bg } = ACCENT_PALETTE[accentColor];
  return (
    <div
      data-slot="installed-extension-card"
      data-accent={accentColor}
      data-archived={archived ? "" : undefined}
      className={cn(
        "flex flex-col overflow-hidden rounded-card border border-line bg-surface-strong shadow-sm md:flex-row md:items-stretch",
        className,
      )}
    >
      {/* LEFT — the ListingCard mark at listing-card width; archived cards
          render the muted (light-grey) variant of the mark. */}
      <ExtensionCardListingBanner
        name={name}
        accentColor={accentColor}
        emblem={emblem}
        iconUrl={iconUrl}
        muted={archived}
        className="p-4 md:w-[340px] md:shrink-0"
      />

      {/* MIDDLE — byline, description, version + status. */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 px-[18px] py-[15px]">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {kindIcon && (
            <span
              aria-hidden
              className={cn("inline-flex shrink-0", archived && "text-muted-foreground")}
              style={archived ? undefined : { color: bg }}
            >
              {kindIcon}
            </span>
          )}
          <span className="truncate">
            <span
              className={cn(
                "font-medium",
                archived ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {kindLabel}
            </span>
            {vendor && (
              <>
                {" by "}
                <span
                  className={cn(
                    "font-medium",
                    archived ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {vendor}
                </span>
              </>
            )}
          </span>
        </div>
        {description && (
          <p className="line-clamp-3 text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        )}
        <div
          data-slot="installed-extension-spec-line"
          className={cn(
            // §VI version row: mono version + status dot, 14px apart (drawing).
            "flex flex-wrap items-center gap-x-3.5 gap-y-1.5",
            archived && "opacity-70",
          )}
        >
          {version && (
            <span className="font-mono text-xs text-muted-foreground">{version}</span>
          )}
          {status}
        </div>
        {chips && (
          <div
            data-slot="installed-extension-operational-chips"
            className={cn(
              "flex flex-wrap items-center gap-x-1.5 gap-y-1.5",
              archived && "opacity-70",
            )}
          >
            {chips}
          </div>
        )}
      </div>

      {/* RIGHT — hairline-divided actions panel; archived cards mute it so the
          whole card reads inactive while Restore / Reinstall stay operable. */}
      {actions && (
        <div
          className={cn(
            "flex flex-col items-stretch justify-center gap-2 border-t border-line p-4 md:w-[176px] md:shrink-0 md:border-l md:border-t-0",
            archived && "opacity-70",
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
