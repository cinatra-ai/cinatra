import type { ReactNode } from "react";
import { Check, RefreshCw, X } from "lucide-react";
// Extended tailwind-merge (same reason as extension-card.tsx): the default app
// cn strips the custom design-token size utilities whenever a text-COLOR class
// follows in the same merge.
import { cn } from "@cinatra-ai/sdk-ui/lib/utils";
import {
  ExtensionCardListingBanner,
  type ExtensionAccent,
} from "@/components/extension-card";

/**
 * InstalledExtensionCard — the design system's "Installed extensions" card
 * (published design system, "Installed extensions" section): ONE horizontal
 * card per installed extension, split three ways.
 *
 *   1. LEFT — the ListingCard mark (46px icon tile + italic display name on
 *      the extension's accent ground) with the "{Kind} by {Vendor}" byline
 *      beneath the name (design spec 0.5.0 §III moved the byline into this
 *      coloured panel, recoloured white/grey to match the name), reused from
 *      `ExtensionCardListingBanner` at listing-card width (340px).
 *   2. MIDDLE — the description, then the mono version with the lifecycle
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
  /** Small kind glyph for the byline (white on the coloured banner ground). */
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
   * §III update affordance (cinatra#1041 outcome 3) rendered on the spec line
   * AFTER the lifecycle status — the blue `UpdateAvailableChip` when a newer
   * compatible registry version is published. The card is presentational: the
   * caller derives the chip via `deriveInstalledUpdateChipState`. Absent for
   * every non-§VI caller (§VII agents, marketplace) and for the up-to-date /
   * fail-quiet states, so the spec line renders exactly as before.
   */
  updateChip?: ReactNode;
  /**
   * §III explanatory note (`InstalledUpdateNote`) rendered BELOW the spec line
   * for the two no-chip-but-explained states: `incompatible` and
   * `non-comparable`. The fail-quiet state passes nothing.
   */
  updateNote?: ReactNode;
  /**
   * §III ABI-incompatible greying: mutes the version/status spec-line row
   * (opacity, the §I ABI-compat treatment) when a newer version exists but
   * needs a newer Cinatra. The `updateNote` sibling stays at full opacity.
   */
  specLineMuted?: boolean;
  /**
   * Right-panel actions — exactly the §VI drawing's two: Settings then More
   * details, ALWAYS both (owner ruling, 2026-07-05). No management actions
   * (Update/Uninstall/Restore/Reinstall/admin-overflow) and no chips belong
   * on the card.
   */
  actions?: ReactNode;
  /**
   * Description clamp — 2 lines everywhere since cinatra#1005: §VI
   * (Installed extensions) caps the card description at two lines, matching
   * the derived §VII "Agent card (All Agents)" (cinatra#1007 / design#25).
   * The 3-line variant remains addressable for a future caller, but no
   * current surface uses it — the default is 2.
   */
  descriptionLineClamp?: 2 | 3;
  /**
   * Archived / fully-greyed §VI treatment (cinatra#957): the accent ground
   * desaturates to light grey, the logo tile inks muted, and every text /
   * status / action zone renders muted grey. Active cards keep their
   * category colour.
   */
  archived?: boolean;
  /**
   * cinatra#1121 — /agents All-Agents accent affordance. `accentDetailHref` makes
   * the LEFT accent panel a pointer-cursor click target (an `<a>` whose href is
   * the no-JS full-page-detail fallback; `onAccentActivate` opens the §V detail
   * modal in place). `accentInert` renders the panel inert with a default cursor
   * for agent rows that have no listing (external A2A / unscoped). Every other
   * caller (§VI installed extensions, marketplace) omits all four → the accent
   * stays a presentational panel, byte-identical.
   */
  accentDetailHref?: string;
  onAccentActivate?: () => void;
  accentLabel?: string;
  accentInert?: boolean;
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

/**
 * §III "Update available" chip (published design system §III, spec-line update
 * states). It REUSES the §VI status-indicator badge treatment — the same
 * `text-badge-2xs`, mono, uppercase, weight-700, 12px-mark kicker style as
 * `InstalledStatusIndicator` — but in the `--info` (`text-info`) blue action
 * accent with a circular-arrow glyph, so it reads as timely NEWS, not an
 * action (the update itself runs from the §II detail-modal footer; the card's
 * actions stay exactly Settings + More details). It renders ONLY when a newer
 * COMPATIBLE registry version is published for a registry-comparable source;
 * the derivation lives in `deriveInstalledUpdateChipState`
 * (installed-update-chip.ts). `strokeWidth` 2.4 matches the spec's arrow mark.
 */
export function UpdateAvailableChip() {
  return (
    <span
      data-slot="status-indicator"
      data-status="update-available"
      className={cn(
        // Mirror InstalledStatusIndicator's canonical badge kicker (named
        // tokens per the ui-design-system gate; no arbitrary text-[]/tracking-[]).
        "inline-flex items-center gap-1.5 font-mono text-badge-2xs font-bold uppercase",
        "text-info",
      )}
      title="A newer compatible version is published — update from More details."
    >
      <RefreshCw aria-hidden className="size-3 shrink-0" strokeWidth={2.4} />
      Update available
    </span>
  );
}

/**
 * §III spec-line explanatory note (published design system §III). A small,
 * muted mono caption rendered BELOW the version/status line for the two states
 * that show no chip but DO explain themselves: `incompatible` ("Newer version
 * needs a newer Cinatra") and `non-comparable` ("No registry version to
 * compare"). The fail-quiet `none` state renders nothing at all.
 */
export function InstalledUpdateNote({ children }: { children: ReactNode }) {
  return (
    <div
      data-slot="installed-update-note"
      className="font-mono text-badge-2xs font-semibold tracking-normal text-muted-foreground"
    >
      {children}
    </div>
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
  updateChip,
  updateNote,
  specLineMuted = false,
  actions,
  archived = false,
  className,
  descriptionLineClamp = 2,
  accentDetailHref,
  onAccentActivate,
  accentLabel,
  accentInert = false,
}: InstalledExtensionCardProps) {
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
      {/* LEFT — the ListingCard mark at listing-card width, carrying the
          "{Kind} by {Vendor}" byline beneath the name (design spec 0.5.0 §III:
          byline moved into the coloured panel). The byline inherits the banner
          ground colour via `text-current` — white on an active card, grey on
          the muted (archived) variant — so it recolours to match the name. */}
      <ExtensionCardListingBanner
        name={name}
        accentColor={accentColor}
        emblem={emblem}
        iconUrl={iconUrl}
        muted={archived}
        byline={
          <div
            data-slot="installed-extension-byline"
            className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs leading-tight text-current"
          >
            {kindIcon && (
              <span aria-hidden className="inline-flex shrink-0 text-current">
                {kindIcon}
              </span>
            )}
            <span className="overflow-hidden text-ellipsis">
              <span className="font-medium">{kindLabel}</span>
              {vendor && (
                <>
                  {" by "}
                  <span className="font-medium">{vendor}</span>
                </>
              )}
            </span>
          </div>
        }
        className="p-4 md:w-[340px] md:shrink-0"
        detailHref={accentDetailHref}
        onActivate={onAccentActivate}
        activateLabel={accentLabel}
        inert={accentInert}
      />

      {/* MIDDLE — description, version + status (the byline moved into the
          coloured panel above in 0.5.0 §III). */}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 px-[18px] py-[15px]">
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
        {(version || status || updateChip) && (
          <div
            data-slot="installed-extension-spec-line"
            className={cn(
              // §VI version row: mono version + lifecycle indicator, 14px apart (drawing).
              "flex flex-wrap items-center gap-x-3.5 gap-y-1.5",
              archived && "opacity-70",
              // §III ABI-incompatible greying — the §I ABI-compat treatment
              // dims the version/status row (design spec: opacity ≈ 0.55) while
              // the explanatory note below stays legible.
              specLineMuted && "opacity-55",
            )}
          >
            {version && (
              <span className="font-mono text-xs text-muted-foreground">{version}</span>
            )}
            {status}
            {updateChip}
          </div>
        )}
        {/* §III explanatory note (incompatible / non-comparable) — a sibling of
            the spec line so it stays at full opacity under the greyed row. */}
        {updateNote}
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
