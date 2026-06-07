import * as React from "react";
import { cn } from "@/lib/utils";
import {
  ACCENT_PALETTE,
  type ExtensionAccent,
} from "@/lib/extension-accent";

/**
 * ExtensionCard — the canonical presentation for an extension instance.
 *
 * One card. Emblem (left) — a fixed type icon or vendor brand logo,
 * wrapped in a white pill so brand colour reads against any ground.
 * Indicator (right) — a live state pill (Connected, Scheduled, Updating…).
 * Background colour — drawn at random from the palette accents at
 * creation time. Persist `accentColor` on the row in DB; do not pick
 * fresh on each render.
 *
 * Two render modes:
 *   - Button mode (default): the whole card is a clickable <button>.
 *     Used for running-agent / installed-extension lists where callers
 *     depend on stable button markup.
 *   - Shell mode (when `footer`/`description` provided OR `interactive=false`):
 *     renders a <div> with the accent chip on top and a presentation body
 *     (description, meta, footer) beneath it. Used by the marketplace, where
 *     each tile carries badges + an Install/Update/Restore CTA <form> that
 *     cannot legally nest inside a <button>.
 *
 * Palette source-of-truth lives in `@/lib/extension-accent`. Avatar reads the
 * same `ACCENT_PALETTE` so the two components cannot diverge on hex values.
 *
 * Usage:
 *   <ExtensionCard
 *     name="Email Outreach Agent"
 *     accentColor="indigo"
 *     emblem={<BotIcon />}
 *     indicator={{ label: "Daily 9am", dotColour: "var(--success)" }}
 *   />
 */

export type { ExtensionAccent };

export type ExtensionIndicator = {
  label: string;
  dotColour?: string;     // CSS colour string; defaults to success green
  spinning?: boolean;     // small spinner instead of a dot (e.g. "Updating")
};

export type ExtensionCardProps = {
  name: string;
  accentColor: ExtensionAccent;
  emblem: React.ReactNode;
  indicator?: ExtensionIndicator;
  onClick?: () => void;
  className?: string;
  /** Shell-mode body slots — presence triggers the <div> shell. */
  description?: React.ReactNode;
  meta?: React.ReactNode;
  footer?: React.ReactNode;
  /** Replaces the indicator in the chip top-right (e.g. kind + visibility badges). */
  badges?: React.ReactNode;
  /** Force render mode. Defaults to true (button) unless body slots are present. */
  interactive?: boolean;
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
}: ExtensionCardProps) {
  // Shell mode whenever the card carries body content (CTA forms can't nest in
  // a <button>) or the caller explicitly opts out of the clickable button.
  const isShell =
    interactive === false ||
    description !== undefined ||
    meta !== undefined ||
    footer !== undefined;

  if (!isShell) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-slot="extension-card"
        data-accent={accentColor}
        // `aria-label` is explicit so axe-core picks up the accessible name
        // even when the visible name uses `font-display` italic-800, which
        // some scrapers treat as decorative.
        aria-label={name}
        className={cn(
          "group/extension relative w-full overflow-hidden rounded-card border border-line bg-surface-strong text-left transition-all hover:-translate-y-px hover:shadow-strong focus-visible:ring-3 focus-visible:ring-ring/40 outline-none",
          className,
        )}
      >
        <ExtensionCardChip
          name={name}
          accentColor={accentColor}
          emblem={emblem}
          indicator={indicator}
        />
      </button>
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
      <ExtensionCardChip
        name={name}
        accentColor={accentColor}
        emblem={emblem}
        indicator={indicator}
        badges={badges}
      />
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

function Indicator({
  label,
  dotColour,
  spinning,
}: { label: string; dotColour: string; spinning?: boolean }) {
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
