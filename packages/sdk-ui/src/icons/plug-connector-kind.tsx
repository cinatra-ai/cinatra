import type { SVGProps } from "react";

/**
 * PlugConnectorKind — the "connector" kind emblem (cinatra#2364, epic #2360).
 *
 * The LOWER HALF of the joined-plug mark used for the connected-status glyph
 * elsewhere in the design system (the full glyph #2356 defines as
 * `PlugConnected` in this SAME sdk-ui module) — recentred and rescaled
 * across the full 24-unit viewBox, NOT a literal crop, so it reads clean at
 * the 13px byline size. Path data and the `translate`/`scale` recentring are
 * copied verbatim from the ratified card spec's own drawing. Supersedes both
 * the app's prior lucide `Plug` kind emblem and an earlier spec rendering —
 * "what kind of extension is this" and "is it connected" now read as one
 * icon family.
 *
 * This file is the single owner of the joined-plug glyph family in sdk-ui —
 * #2356 (connectors S3) adds the full `PlugConnected` mark to this SAME
 * module when it lands; a second glyph module must not be created for it.
 *
 * Prop-compatible with the lucide-react icons it replaces at every call
 * site: forwards `className` and any other native `<svg>` prop (including a
 * caller-supplied `strokeWidth` override), and inherits `currentColor` like
 * every other kind emblem.
 */
export function PlugConnectorKind({
  className,
  strokeWidth,
  ...props
}: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? 1.85}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      {...props}
    >
      {/* Recentre + rescale the full joined-plug drawing's lower half across
          the 24-unit viewBox (verbatim from the spec's own transform). The
          group's strokeWidth derives from the caller value (1.32 default
          calibration) — the paths inherit from THIS <g>, not the root <svg>,
          so a caller override must be forwarded here too or it has zero
          visual effect on the drawn glyph (only the root attribute changes). */}
      <g
        transform="translate(-1.03,-11.33) scale(1.515)"
        strokeWidth={strokeWidth ?? 1.32}
      >
        <path d="m2 22 6-6" />
        <path d="M9.3 17.3a2.4 2.4 0 0 0 3.4 0L15 15l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
        <path d="M10.5 10.5 13 8" />
        <path d="M13.5 13.5 16 11" />
      </g>
    </svg>
  );
}
