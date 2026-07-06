import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
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
 *   3. RIGHT — a hairline-divided actions panel carrying EXACTLY the §VI
 *      drawing's two actions — Settings (primary, only where a configuration
 *      surface exists) + More details — nothing else (cinatra#948 reopen,
 *      2026-07-05: Update/Uninstall/Reinstall/admin-overflow are not in the
 *      drawing; the caller relocates that management surface into the "More
 *      details" §V modal instead of rendering it on the card).
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
   * Right-panel actions — exactly the §VI drawing's two: Settings then More
   * details, ALWAYS both (owner ruling, 2026-07-05). No management actions
   * (Update/Uninstall/Restore/Reinstall/admin-overflow) and no chips belong
   * on the card.
   */
  actions?: ReactNode;
  /**
   * Description clamp — §VI (Installed extensions) is 3 lines; the derived
   * §VII "Agent card (All Agents)" (cinatra#1007 / design#25) clamps to 2
   * lines since it carries no version/status row to share the middle panel
   * with. Defaults to 3 so every existing §VI caller is unaffected.
   */
  descriptionLineClamp?: 2 | 3;
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
 * drawing, refreshed 2026-07-05: "green-check Active / grey-cross
 * Archived"). A check icon (green) for Active/Locked, a cross icon (muted)
 * for Archived, beside the mono, uppercase, letter-spaced label. The earlier
 * "bare dot" reading of this indicator (this branch's prior commits) cited a
 * now-superseded revision of the published reference — the current §VI
 * example markup renders an explicit check/cross `<svg>`, not a bare dot.
 * Active and `locked` (a system extension is live) read green; archived
 * reads muted. The general `LifecycleBadge`/`StatusPill` stays the §VII
 * list/table renderer.
 */
export function InstalledStatusIndicator({
  status,
}: {
  status: "active" | "locked" | "archived";
}) {
  const archived = status === "archived";
  const label = archived ? "Archived" : status === "locked" ? "Locked" : "Active";
  const Icon = archived ? X : Check;
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
      <Icon aria-hidden className="size-3 shrink-0" strokeWidth={3} />
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
  actions,
  archived = false,
  className,
  descriptionLineClamp = 3,
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
          <p
            className={cn(
              "text-sm leading-relaxed text-muted-foreground",
              descriptionLineClamp === 2 ? "line-clamp-2" : "line-clamp-3",
            )}
          >
            {description}
          </p>
        )}
        {/* §VII "Agent card (All Agents)" (cinatra#1007) passes neither version
            nor status → the whole spec line is omitted (no empty middle-panel
            row). §VI callers always pass at least the lifecycle indicator, so
            the row renders exactly as before. */}
        {(version || status) && (
          <div
            data-slot="installed-extension-spec-line"
            className={cn(
              // §VI version row: mono version + lifecycle indicator, 14px apart (drawing).
              "flex flex-wrap items-center gap-x-3.5 gap-y-1.5",
              archived && "opacity-70",
            )}
          >
            {version && (
              <span className="font-mono text-xs text-muted-foreground">{version}</span>
            )}
            {status}
          </div>
        )}
      </div>

      {/* RIGHT — hairline-divided actions panel. §VI drawing: exactly
          Settings + More details, naturally sized and CENTERED (not
          stretched full-width) — `align-items: center` on the panel, no
          per-button width utility. Archived cards mute the whole panel
          (cinatra#957) while both actions stay operable. */}
      {actions && (
        <div
          className={cn(
            // gap-[9px]: the drawing's exact 9px actions-panel gap (a layout
            // arbitrary, not a color/type one — cinatra#803 convention).
            "flex flex-col items-center justify-center gap-[9px] border-t border-line p-4 md:w-[176px] md:shrink-0 md:border-l md:border-t-0",
            archived && "opacity-70",
          )}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
