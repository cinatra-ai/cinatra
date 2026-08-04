import { createLucideIcon, type IconNode, type LucideProps } from "lucide-react";

// ---------------------------------------------------------------------------
// First-party Cinatra glyphs (cinatra#2356, epic #2353).
//
// The home for design-spec glyphs that the lucide set does not carry. Every
// glyph here is built with lucide's own public `createLucideIcon` factory, so
// each one is a drop-in for a lucide icon at any call site: same `LucideProps`
// contract (`size` / `color` / `strokeWidth` / `absoluteStrokeWidth` /
// `className` / any SVG attribute / ref), the same rendered chrome
// (`xmlns` + `viewBox="0 0 24 24"` + `fill="none"` + `stroke="currentColor"` +
// `stroke-width="2"` + round caps/joins + the `lucide` class + the automatic
// `aria-hidden` when no a11y prop is passed), and the same 24x24 default box
// that the surrounding `[&_svg]:size-*` utilities resize.
//
// This module is DELIBERATELY a plural registry, not a single-glyph file: the
// design system is expected to gain further first-party marks. Adding one is
// two lines — an exported `…_ICON_NODE` (the path set, verbatim from the spec)
// plus a `createLucideIcon("<kebab-name>", NODE)` component below it. The
// nodes are exported alongside the components so a consumer (or a lock test)
// can assert the exact geometry without rendering.
//
// Ships from its OWN `@cinatra-ai/sdk-ui/icons` subpath and is NOT added to
// the root barrel or the `/marketplace` barrel — those are ratchet-locked
// module graphs (see the `./tabs` precedent in ui/tabs.tsx).
// ---------------------------------------------------------------------------

/** The props every glyph in this module accepts — lucide's own icon props. */
export type CinatraIconProps = LucideProps;

/**
 * `PlugConnected` — the joined plug.
 *
 * design/specs/app-connectors.html v0.7.0 (pinned at design@3d33cc800) draws
 * the Connected state as literally the two halves of the Disconnected
 * (`Unplug`) glyph with the gap closed. lucide has no such icon: `PlugZap` is
 * a half plug plus a lightning bolt, and `Plug` is a different drawing
 * altogether, so neither pairs visually with `Unplug`.
 *
 * The geometry is the spec's path set, copied verbatim and in the spec's own
 * order. It is `Unplug` (lucide v1.20.0) with:
 *   - the socket half translated +3,-3 and the plug half translated -3,+3, so
 *     the two bodies meet on the 9,9 → 15,15 diagonal instead of standing off
 *     it (`M6.3 20.3…L12 18l-6-6…` → `M9.3 17.3…L15 15l-6-6…`;
 *     `m12 6 6 6 2.3-2.3…` → `m9 9 6 6 2.3-2.3…`);
 *   - the cord and prong runs redrawn from the new corners and lengthened from
 *     3 to 6 units (`m19 5 3-3` → `m16 8 6-6`; `m2 22 3-3` → `m2 22 6-6`);
 *   - the two loose prong strokes of the pulled-apart plug (`M7.5 13.5 10 11`
 *     and `M10.5 16.5 13 14`) DROPPED — there is no gap left for them to sit
 *     in once the halves are joined.
 *
 * Rendered by the /connectors toggle segment + card badge, the setup page's
 * connection-status badge (cards, roll-up and Connections rows), and the setup
 * form's Connect action — one definition, no per-package twins.
 */
export const PLUG_CONNECTED_ICON_NODE: IconNode = [
  ["path", { d: "m16 8 6-6", key: "plug-connected-prong" }],
  ["path", { d: "m2 22 6-6", key: "plug-connected-cord" }],
  [
    "path",
    {
      d: "M9.3 17.3a2.4 2.4 0 0 0 3.4 0L15 15l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z",
      key: "plug-connected-socket-half",
    },
  ],
  [
    "path",
    {
      d: "m9 9 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z",
      key: "plug-connected-plug-half",
    },
  ],
];

export const PlugConnected = createLucideIcon(
  "plug-connected",
  PLUG_CONNECTED_ICON_NODE,
);
