/**
 * Tailscale brand mark — 3x3 grid of dots. The four corners + centre are
 * filled (currentColor); the edge midpoints are faint. Inherits text color
 * so it adapts to badges, list rows, and connector cards.
 *
 * Shared by the /connectors card grid and the dev-tab tunnel flyout.
 */
export function TailscaleLogo({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <g fill="currentColor">
        <circle cx="4" cy="4" r="2" />
        <circle cx="20" cy="4" r="2" />
        <circle cx="12" cy="12" r="2" />
        <circle cx="4" cy="20" r="2" />
        <circle cx="20" cy="20" r="2" />
      </g>
      <g fill="currentColor" fillOpacity="0.25">
        <circle cx="12" cy="4" r="2" />
        <circle cx="4" cy="12" r="2" />
        <circle cx="20" cy="12" r="2" />
        <circle cx="12" cy="20" r="2" />
      </g>
    </svg>
  );
}
