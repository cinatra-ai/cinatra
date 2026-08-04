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
 * design/specs/app-connectors.html version 0.7.0 (pinned at design@3d33cc800) draws
 * the Connected state as literally the two halves of the Disconnected
 * (`Unplug`) glyph with the gap closed. lucide has no such icon: `PlugZap` is
 * a half plug plus a lightning bolt, and `Plug` is a different drawing
 * altogether, so neither pairs visually with `Unplug`.
 *
 * The geometry is the spec's path set, copied verbatim and in the spec's own
 * order. It is `Unplug` (lucide 1.20.0) with:
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

/**
 * `PlugConnectorKind` — the lower half of the joined plug, as the extension
 * KIND emblem for connectors.
 *
 * design/specs/app-extensions.html version 0.11.0 (pinned at design@c144f39a8)
 * redraws the Connector byline glyph and the §II dependency-list connector
 * instance as the lower half of `PlugConnected` above, so "what kind of
 * extension is this" and "is it connected" read as one icon family. It
 * supersedes both that spec's prior lucide `Link` rendering and the app's
 * lucide `Plug`.
 *
 * NOT a literal crop. The spec draws the half inside a wrapper group —
 * `<g transform="translate(-1.03,-11.33) scale(1.515)" stroke-width="1.32">` —
 * which recentres and rescales it across the full 24-unit viewBox (the drawn
 * geometry spans x 2→23.21, y 0.79→22) so it still reads at the 13px byline
 * size. Its members are:
 *   - the joined plug's cord run (`m2 22 6-6`) and lower/socket capsule
 *     (`M9.3 17.3…Z`), carried over unchanged;
 *   - two short prong strokes, which the joined mark itself deliberately drops
 *     (nothing is pulled apart there, so there is no gap for them to sit in).
 *     Cut down to the half alone the capsule read ambiguous rather than as a
 *     plug, so the spec reinstates them from the same family's `Unplug` glyph
 *     (`M7.5 13.5 10 11` / `M10.5 16.5 13 14`), shifted by the same +3,-3 that
 *     separates the `Unplug` capsule from the joined one → `M10.5 10.5 13 8`
 *     and `M13.5 13.5 16 11` in the joined mark's coordinate frame.
 *
 * lucide's `IconNode` is a FLAT child list (`[element, attrs][]` — no group
 * element), so the wrapper transform is folded into the coordinates here
 * instead: `x' = 1.515x - 1.03`, `y' = 1.515y - 11.33`, arc radii `× 1.515`.
 * Every one of those products terminates within four decimals, so the fold is
 * EXACT — the GEOMETRY is the spec's drawing, not an approximation of it. The
 * paths stay in the spec's own order.
 *
 * The stroke then needs no prop, and this is where "exact" becomes "to within
 * 2/10000 of a unit": the spec's `stroke-width="1.32"` inside a `scale(1.515)`
 * group renders at `1.32 × 1.515 = 1.9998` user units, and lucide's own default
 * is `2`. That is ~1.08px at the 13px byline, inside the ~1.85–2.2 band this
 * spec's other 13px glyphs occupy. Rasterised at 1024², the two marks differ in
 * 4 pixels of 1,048,576 with the strokes matched, 262 (all antialiasing at the
 * stroke edge) as shipped.
 *
 * Both prong caps overrun the viewBox by 0.21 units — the outer one past the
 * top (y −0.21), the inner one past the right (x 24.21) — so each is
 * hairline-clipped. Inherited from the spec's own drawing at these
 * coordinates, not introduced here, and below half a pixel at every size the
 * emblem is rendered at.
 *
 * Distinct from `PlugConnected`: this is a KIND emblem (connector, alongside
 * Bot / FileText / Package / Sparkles / Workflow), never a connection-state
 * mark. `src/components/__tests__/status-glyph-scope.test.ts` locks that
 * boundary in both directions.
 */
export const PLUG_CONNECTOR_KIND_ICON_NODE: IconNode = [
  ["path", { d: "m2 22 9.09-9.09", key: "plug-connector-kind-cord" }],
  [
    "path",
    {
      d: "M13.0595 14.8795a3.636 3.636 0 0 0 5.151 0L21.695 11.395l-9.09-9.09-3.4845 3.4845a3.636 3.636 0 0 0 0 5.151Z",
      key: "plug-connector-kind-capsule",
    },
  ],
  ["path", { d: "M14.8775 4.5775 18.665 0.79", key: "plug-connector-kind-prong-outer" }],
  ["path", { d: "M19.4225 9.1225 23.21 5.335", key: "plug-connector-kind-prong-inner" }],
];

export const PlugConnectorKind = createLucideIcon(
  "plug-connector-kind",
  PLUG_CONNECTOR_KIND_ICON_NODE,
);
