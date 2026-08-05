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
// two lines — an exported `…_ICON_NODE` (the path set, verbatim from the spec;
// or, when the spec draws through a group transform the flat `IconNode` cannot
// carry, the spec's own transform applied to its coordinates and the
// derivation locked in the tests — see `PlugConnectorKind`)
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
 * `PlugConnectorKind` — the "connector" extension-KIND emblem (cinatra#2364,
 * epic #2360): the LOWER HALF of the joined-plug mark `PlugConnected` draws
 * above, recentred and rescaled across the full 24-unit viewBox — not a
 * literal crop — so it reads clean at the 13px byline size. "What kind of
 * extension is this" and "is it connected" thereby read as one icon family
 * without collapsing into one component: this export is the KIND vocabulary,
 * `PlugConnected` the STATUS vocabulary, and the two never substitute for
 * each other (locked by src/components/__tests__/status-glyph-scope.test.ts
 * in the host app). Supersedes lucide's generic `Plug` in the kind emblem.
 *
 * GEOMETRY — the spec's transform, applied rather than carried. The ratified
 * card spec draws this glyph as four paths (cord, socket half, two prong
 * stubs — the joined plug minus its upper half) inside a nested
 * `<g transform="translate(-1.03,-11.33) scale(1.515)" stroke-width="1.32">`
 * under a 1.85-stroke root. `IconNode` is a flat `[tag, attrs][]` — no
 * nested groups, no dynamic per-node attributes — and carrying the transform
 * on each path instead would multiply the DRAWN stroke by the 1.515 scale
 * (lucide's default 2 would paint at 3.03). So the affine map is applied to
 * the path COORDINATES once, here: (x, y) → (1.515·x − 1.03, 1.515·y − 11.33);
 * relative deltas and arc radii × 1.515; arc flags untouched. Identical
 * rendered geometry, unit stroke space. The derivation is LOCKED in
 * __tests__/icons.test.tsx, which recomputes these strings from the spec's
 * own pre-transform drawing and compares them literally.
 *
 * STROKE — lucide's default chrome IS the spec's calibration. The spec's
 * nested pair nets a drawn weight of 1.32 × 1.515 = 1.99998 — lucide's own
 * default stroke-width of 2, to 0.01%. With the transform baked, the entry
 * therefore draws the spec's exact calibrated weight at default props, and a
 * caller-supplied `strokeWidth` scales the drawing proportionally like every
 * lucide icon (the predecessor single-file component forwarded caller
 * overrides UNDER the 1.515 group scale — ~1.4× too heavy). One residual vs
 * the spec's root:group ratio (1.32/1.85): a strict ratio reading would scale
 * an override by ×1.081 rather than ×1.0 — inexpressible without dynamic
 * per-node attributes, ~8% off only under an explicit override, and exact at
 * the defaults every production call site uses (they pass `className` only).
 */
export const PLUG_CONNECTOR_KIND_ICON_NODE: IconNode = [
  ["path", { d: "M2 22l9.09 -9.09", key: "plug-connector-kind-cord" }],
  [
    "path",
    {
      d: "M13.0595 14.8795a3.636 3.636 0 0 0 5.151 0L21.695 11.395l-9.09 -9.09l-3.4845 3.4845a3.636 3.636 0 0 0 0 5.151Z",
      key: "plug-connector-kind-socket-half",
    },
  ],
  ["path", { d: "M14.8775 4.5775L18.665 0.79", key: "plug-connector-kind-prong-a" }],
  ["path", { d: "M19.4225 9.1225L23.21 5.335", key: "plug-connector-kind-prong-b" }],
];

export const PlugConnectorKind = createLucideIcon(
  "plug-connector-kind",
  PLUG_CONNECTOR_KIND_ICON_NODE,
);
