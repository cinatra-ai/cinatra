import { Check, Lock, X } from "lucide-react";
// Extended tailwind-merge (same reason as installed-extension-card.tsx): the
// default app cn strips the custom design-token size utilities whenever a
// text-COLOR class follows in the same merge.
import { cn } from "@cinatra-ai/sdk-ui/lib/utils";

/**
 * §VI "Installed extensions" status indicator (published design system §VI
 * drawing, refreshed 2026-07-05). Three lifecycle glyphs beside the mono,
 * uppercase, letter-spaced label:
 *   • active   → a green check;
 *   • locked   → a green LOCK (cinatra#1570). A system extension IS live, so it
 *     shares the green `--success` ink, but it now reads DISTINCTLY from a
 *     normal active row: it cannot be archived or uninstalled (the tooltip
 *     says so). Previously locked silently reused the active check, making a
 *     locked row visually identical to an active one but for the text label;
 *   • archived → a muted cross.
 * Colour/semantics are pinned by the paired `app-extensions.html` spec update
 * that lands with this change (design-surface gate). The general
 * `LifecycleBadge`/`StatusPill` stays the §VII list/table renderer.
 *
 * It is the ONE Extensions lifecycle chip: the installed card and the
 * Extensions package's chip row (`LifecycleBadges`) both draw it, so Active,
 * Locked and Archived read as the same marked text on every Extensions surface
 * (Extensions drawing, "Example — lifecycle status"; cinatra#4296).
 */
export function InstalledStatusIndicator({
  status,
}: {
  status: "active" | "locked" | "archived";
}) {
  const archived = status === "archived";
  const locked = status === "locked";
  const label = archived ? "Archived" : locked ? "Locked" : "Active";
  const Icon = archived ? X : locked ? Lock : Check;
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
