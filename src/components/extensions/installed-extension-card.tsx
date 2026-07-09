import type { ReactNode } from "react";
import Link from "next/link";
import { Check, TriangleAlert, X } from "lucide-react";
// Extended tailwind-merge (same reason as extension-card.tsx): the default app
// cn strips the custom design-token size utilities whenever a text-COLOR class
// follows in the same merge.
import { cn } from "@cinatra-ai/sdk-ui/lib/utils";
import {
  ExtensionCardListingBanner,
  type ExtensionAccent,
} from "@/components/extension-card";
import { ACCENT_PALETTE } from "@/lib/extension-accent";
import type { ConfigurationNeed } from "@/lib/extension-dependency-ux";

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
   * Post-install "needs configuration" affordance (cinatra#1057). When a
   * just-installed AGENT still has one or more UNCONFIGURED required connector
   * dependencies, the caller passes them here. A non-empty list flips the card
   * into the same greyed archived TREATMENT (a cannot-run agent) and attaches a
   * needs-review status strip to the bottom of the card listing each
   * connector's displayName, deep-linked to its setup page. The card returns to
   * its active colours and the strip disappears the moment all are configured
   * (the caller stops passing them). Install itself never blocks — the strip is
   * a follow-up reminder, not a gate. Distinct from `archived` (lifecycle):
   * a needs-review card is active-but-unrunnable, not archived.
   */
  configurationNeeds?: readonly ConfigurationNeed[];
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
 * §"post-install configuration needs" strip (Extensions application-design
 * spec, needs-review section; cinatra#1057). A thin status strip attached to
 * the bottom of an affected agent's card, in the design system's Needs-review
 * status colours — the `.pill.hold` mustard tint (`bg-warning/10`) over the
 * mustard ink (`text-warning`, i.e. the brand mustard #c79545 = rgb(199,149,69))
 * with a mustard hairline on top (`border-warning/42`). Content is CENTRED: a
 * warning glyph, "Set up connections first:", then each REQUIRED connector's
 * human-readable displayName as a link to that connector's setup page. The
 * strip appears only while at least one required connector is unconfigured; the
 * caller drops `configurationNeeds` (and the strip) the moment all are set up.
 */
function NeedsReviewStrip({ connectors }: { connectors: readonly ConfigurationNeed[] }) {
  return (
    <div
      data-slot="install-config-needs-callout"
      data-conformance="install-config-needs-callout"
      className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t border-warning/42 bg-warning/10 px-4 py-2.5 text-xs text-warning"
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" strokeWidth={2.25} />
      <span className="font-medium">Set up connections first:</span>
      {connectors.map((connector, index) => (
        <span key={connector.packageName} className="inline-flex items-center">
          {connector.settingsHref ? (
            <Link
              href={connector.settingsHref}
              data-field="manifest.displayName"
              className="font-semibold underline decoration-warning/50 underline-offset-2 hover:decoration-warning"
            >
              {connector.displayName}
            </Link>
          ) : (
            <span data-field="manifest.displayName" className="font-semibold">
              {connector.displayName}
            </span>
          )}
          {index < connectors.length - 1 && (
            <span aria-hidden className="ml-2 text-warning/60">
              &middot;
            </span>
          )}
        </span>
      ))}
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
  actions,
  archived = false,
  configurationNeeds,
  className,
  descriptionLineClamp = 2,
  accentDetailHref,
  onAccentActivate,
  accentLabel,
  accentInert = false,
}: InstalledExtensionCardProps) {
  const { bg } = ACCENT_PALETTE[accentColor];
  // An affected agent (unconfigured required connectors) cannot run yet, so it
  // wears the SAME greyed treatment as an archived card — desaturated ground,
  // muted emblem, muted text/actions — plus the needs-review strip below. The
  // greying is driven by `greyed`; `data-archived` still reflects true archived
  // lifecycle only (`data-needs-review` marks the distinct cannot-run state).
  const needsReview = (configurationNeeds?.length ?? 0) > 0;
  const greyed = archived || needsReview;
  return (
    <div
      data-slot="installed-extension-card"
      data-accent={accentColor}
      data-archived={archived ? "" : undefined}
      data-needs-review={needsReview ? "" : undefined}
      className={cn(
        "flex flex-col overflow-hidden rounded-card border border-line bg-surface-strong shadow-sm",
        className,
      )}
    >
      <div className="flex flex-col md:flex-row md:items-stretch">
        {/* LEFT — the ListingCard mark at listing-card width; a greyed card
            (archived or needs-review) renders the muted (light-grey) mark. */}
        <ExtensionCardListingBanner
          name={name}
          accentColor={accentColor}
          emblem={emblem}
          iconUrl={iconUrl}
          muted={greyed}
          className="p-4 md:w-[340px] md:shrink-0"
          detailHref={accentDetailHref}
          onActivate={onAccentActivate}
          activateLabel={accentLabel}
          inert={accentInert}
        />

        {/* MIDDLE — byline, description, version + status. */}
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 px-[18px] py-[15px]">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {kindIcon && (
              <span
                aria-hidden
                className={cn("inline-flex shrink-0", greyed && "text-muted-foreground")}
                style={greyed ? undefined : { color: bg }}
              >
                {kindIcon}
              </span>
            )}
            <span className="truncate">
              <span
                className={cn(
                  "font-medium",
                  greyed ? "text-muted-foreground" : "text-foreground",
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
                      greyed ? "text-muted-foreground" : "text-foreground",
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
                greyed && "opacity-70",
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
            per-button width utility. A greyed card mutes the whole panel
            (cinatra#957) while both actions stay operable. */}
        {actions && (
          <div
            className={cn(
              // gap-[9px]: the drawing's exact 9px actions-panel gap (a layout
              // arbitrary, not a color/type one — cinatra#803 convention).
              "flex flex-col items-center justify-center gap-[9px] border-t border-line p-4 md:w-[176px] md:shrink-0 md:border-l md:border-t-0",
              greyed && "opacity-70",
            )}
          >
            {actions}
          </div>
        )}
      </div>

      {/* BOTTOM — post-install needs-review strip (cinatra#1057). Rendered only
          while the affected agent has unconfigured required connectors. */}
      {needsReview && <NeedsReviewStrip connectors={configurationNeeds!} />}
    </div>
  );
}
