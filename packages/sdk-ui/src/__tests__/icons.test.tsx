/**
 * First-party glyph registry (`@cinatra-ai/sdk-ui/icons`) — cinatra#2356.
 *
 * Unlike the other sdk-ui suites in this folder (source-text contracts), this
 * one RENDERS: the whole point of the glyph is the drawing, and the drawing is
 * a spec deliverable. The root vitest env is "node", so it renders through
 * `react-dom/server` — enough to prove the emitted SVG, its geometry, and the
 * prop forwarding that makes the component a drop-in at lucide call sites.
 *
 * The expected path sets below are the specs' own. Keeping them literal is
 * deliberate: these are the redraw-identity locks, so a "cleanup" that nudged a
 * control point would go red instead of silently shipping a different mark.
 *
 *   - `PlugConnected` — copied VERBATIM from design/specs/app-connectors.html
 *     version 0.7.0 (pinned at design@3d33cc800), where the joined plug is
 *     drawn 15 times (toggle segment, card badges, §II status cards/rows, the
 *     Connect action) from ONE invariant four-path set.
 *   - `PlugConnectorKind` — design/specs/app-extensions.html version 0.11.0
 *     (pinned at design@c144f39a8), the lower half of that mark, with the
 *     spec's own wrapper transform folded into the coordinates exactly (see
 *     the note above `KIND_SPEC_PATHS`).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PlugConnected,
  PLUG_CONNECTED_ICON_NODE,
  PlugConnectorKind,
  PLUG_CONNECTOR_KIND_ICON_NODE,
} from "../icons";

const SRC_DIR = join(__dirname, "..");
const PKG_DIR = join(SRC_DIR, "..");
const iconsSrc = readFileSync(join(SRC_DIR, "icons.tsx"), "utf8");
const indexSrc = readFileSync(join(SRC_DIR, "index.ts"), "utf8");
const marketplaceSrc = readFileSync(join(SRC_DIR, "marketplace.ts"), "utf8");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};

/** design@3d33cc800 · specs/app-connectors.html version 0.7.0 — the joined plug. */
const SPEC_PATHS = [
  "m16 8 6-6",
  "m2 22 6-6",
  "M9.3 17.3a2.4 2.4 0 0 0 3.4 0L15 15l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z",
  "m9 9 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z",
];

const dsOf = (html: string) =>
  Array.from(html.matchAll(/<path[^>]*\sd="([^"]*)"/g)).map((m) => m[1]);
const attr = (html: string, name: string) =>
  html.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

describe("PlugConnected — the spec geometry, redrawn identically", () => {
  it("draws the spec's four paths, in the spec's order, and nothing else", () => {
    const html = renderToStaticMarkup(<PlugConnected />);
    expect(dsOf(html)).toEqual(SPEC_PATHS);
    expect(html.match(/<path/g)).toHaveLength(4);
    // Paths only — no circle/rect/line snuck in.
    expect(html).not.toMatch(/<(circle|rect|line|polyline|polygon|ellipse|g)[\s/>]/);
  });

  it("exports the path set so a consumer/lock can assert geometry without rendering", () => {
    expect(PLUG_CONNECTED_ICON_NODE.map(([tag]) => tag)).toEqual([
      "path",
      "path",
      "path",
      "path",
    ]);
    expect(PLUG_CONNECTED_ICON_NODE.map(([, a]) => a.d)).toEqual(SPEC_PATHS);
  });

  it("is the two Unplug halves joined — it carries NEITHER loose prong stroke", () => {
    // The derivation the spec describes: the halves translate onto the 9,9 →
    // 15,15 diagonal and the pulled-apart plug's two loose prong strokes are
    // dropped (there is no gap left for them). Those two `d`s are unmistakable
    // — their presence would mean the old disconnected drawing leaked in.
    const html = renderToStaticMarkup(<PlugConnected />);
    expect(html).not.toContain("M7.5 13.5 10 11");
    expect(html).not.toContain("M10.5 16.5 13 14");
  });
});

describe("PlugConnected — lucide-identical SVG chrome", () => {
  it("is a 24x24 currentColor stroke icon with round caps/joins and no fill", () => {
    const html = renderToStaticMarkup(<PlugConnected />);
    expect(attr(html, "viewBox")).toBe("0 0 24 24");
    expect(attr(html, "width")).toBe("24");
    expect(attr(html, "height")).toBe("24");
    expect(attr(html, "fill")).toBe("none");
    expect(attr(html, "stroke")).toBe("currentColor");
    expect(attr(html, "stroke-width")).toBe("2");
    expect(attr(html, "stroke-linecap")).toBe("round");
    expect(attr(html, "stroke-linejoin")).toBe("round");
    expect(attr(html, "xmlns")).toBe("http://www.w3.org/2000/svg");
  });

  it("carries the lucide class hooks so existing icon CSS reaches it", () => {
    const html = renderToStaticMarkup(<PlugConnected />);
    const cls = (attr(html, "class") ?? "").split(/\s+/);
    expect(cls).toContain("lucide");
    expect(cls).toContain("lucide-plug-connected");
  });

  it("is decorative by default (auto aria-hidden), like every lucide icon", () => {
    expect(attr(renderToStaticMarkup(<PlugConnected />), "aria-hidden")).toBe(
      "true",
    );
  });
});

describe("PlugConnected — prop-compatible with the lucide call sites it replaces", () => {
  it("forwards className without dropping the lucide classes (the tailwind size/colour hook)", () => {
    // The real call sites style it through the parent's `[&_svg]:size-3.5` and
    // through explicit utilities (e.g. the identity-fallback tile's
    // `h-5 w-5 text-muted-foreground`), so className must survive.
    const html = renderToStaticMarkup(
      <PlugConnected className="h-5 w-5 text-muted-foreground" />,
    );
    const cls = (attr(html, "class") ?? "").split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(["lucide", "h-5", "w-5", "text-muted-foreground"]));
  });

  it("forwards size to BOTH width and height", () => {
    const html = renderToStaticMarkup(<PlugConnected size={14} />);
    expect(attr(html, "width")).toBe("14");
    expect(attr(html, "height")).toBe("14");
  });

  it("forwards strokeWidth and color overrides", () => {
    const html = renderToStaticMarkup(
      <PlugConnected strokeWidth={2.2} color="#fff" />,
    );
    expect(attr(html, "stroke-width")).toBe("2.2");
    expect(attr(html, "stroke")).toBe("#fff");
  });

  it("forwards arbitrary SVG/data/aria props — including the `data-icon` hook the badges pass", () => {
    const html = renderToStaticMarkup(
      <PlugConnected data-icon="inline-start" aria-hidden="true" />,
    );
    expect(attr(html, "data-icon")).toBe("inline-start");
    expect(attr(html, "aria-hidden")).toBe("true");
  });

  it("takes an accessible name when a call site chooses to expose it", () => {
    // Passing an a11y prop suppresses the automatic aria-hidden (lucide
    // semantics) — so a future non-decorative use is not silently muted.
    const html = renderToStaticMarkup(<PlugConnected aria-label="Connected" />);
    expect(attr(html, "aria-label")).toBe("Connected");
    expect(attr(html, "aria-hidden")).toBeUndefined();
  });
});

/**
 * design@c144f39a8 · specs/app-extensions.html version 0.11.0 — the connector
 * KIND emblem, drawn there as the lower half of the joined plug above inside
 * `<g transform="translate(-1.03,-11.33) scale(1.515)" stroke-width="1.32">`.
 *
 * lucide's IconNode is a flat child list, so the wrapper is folded into the
 * coordinates (`x' = 1.515x - 1.03`, `y' = 1.515y - 11.33`, radii `× 1.515`).
 * Every product terminates within four decimals — the values below are the
 * spec's drawing EXACTLY, not a rounded rendering of it, which is why pinning
 * them literally is meaningful rather than brittle.
 */
const KIND_SPEC_PATHS = [
  "m2 22 9.09-9.09",
  "M13.0595 14.8795a3.636 3.636 0 0 0 5.151 0L21.695 11.395l-9.09-9.09-3.4845 3.4845a3.636 3.636 0 0 0 0 5.151Z",
  "M14.8775 4.5775 18.665 0.79",
  "M19.4225 9.1225 23.21 5.335",
];

/** The spec's own pre-fold `d`s, i.e. the four paths INSIDE its `<g>`. */
const KIND_UNFOLDED_PATHS = [
  "m2 22 6-6",
  "M9.3 17.3a2.4 2.4 0 0 0 3.4 0L15 15l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z",
  "M10.5 10.5 13 8",
  "M13.5 13.5 16 11",
];

describe("PlugConnectorKind — the spec geometry, with the wrapper transform folded in", () => {
  it("draws the spec's four paths, in the spec's order, and nothing else", () => {
    const html = renderToStaticMarkup(<PlugConnectorKind />);
    expect(dsOf(html)).toEqual(KIND_SPEC_PATHS);
    expect(html.match(/<path/g)).toHaveLength(4);
    expect(html).not.toMatch(/<(circle|rect|line|polyline|polygon|ellipse|g)[\s/>]/);
  });

  it("exports the path set so a consumer/lock can assert geometry without rendering", () => {
    expect(PLUG_CONNECTOR_KIND_ICON_NODE.map(([tag]) => tag)).toEqual([
      "path",
      "path",
      "path",
      "path",
    ]);
    expect(PLUG_CONNECTOR_KIND_ICON_NODE.map(([, a]) => a.d)).toEqual(
      KIND_SPEC_PATHS,
    );
  });

  it("folds the wrapper transform into the coordinates — it does not drop it", () => {
    // The regression this catches is a quiet one: copy the four `d`s out of the
    // spec's `<g>` without applying its translate/scale and the mark still
    // renders, just half-size in the wrong corner of the viewBox. A `transform`
    // attribute would be the other half of the same mistake (lucide's IconNode
    // has no group element, so a per-path transform is the only way to fake
    // one).
    const html = renderToStaticMarkup(<PlugConnectorKind />);
    for (const unfolded of KIND_UNFOLDED_PATHS) {
      expect(html).not.toContain(`d="${unfolded}"`);
    }
    expect(html).not.toContain("transform");
    expect(html).not.toContain("scale(");
  });

  it("is the LOWER half only — never the whole joined plug", () => {
    // `m16 8 6-6` is the joined mark's upper cord run and `m9 9 6 6…` its upper
    // capsule; either one present (folded or not) means the full glyph leaked
    // in where the half belongs.
    const html = renderToStaticMarkup(<PlugConnectorKind />);
    expect(html).not.toContain("m16 8 6-6");
    expect(html).not.toContain("m9 9 6 6");
    expect(PLUG_CONNECTOR_KIND_ICON_NODE.map(([, a]) => a.d)).not.toEqual(
      PLUG_CONNECTED_ICON_NODE.map(([, a]) => a.d),
    );
  });

  it("carries the two reinstated prong strokes the joined mark drops", () => {
    // The spec's round-2 correction: the capsule alone read ambiguous at 13px,
    // so `Unplug`'s loose prongs come back, shifted by the same +3,-3 — folded,
    // the two shortest paths in the set.
    const ds = PLUG_CONNECTOR_KIND_ICON_NODE.map(([, a]) => a.d);
    expect(ds).toContain("M14.8775 4.5775 18.665 0.79");
    expect(ds).toContain("M19.4225 9.1225 23.21 5.335");
  });
});

describe("PlugConnectorKind — lucide-identical SVG chrome", () => {
  it("is a 24x24 currentColor stroke icon with round caps/joins and no fill", () => {
    const html = renderToStaticMarkup(<PlugConnectorKind />);
    expect(attr(html, "viewBox")).toBe("0 0 24 24");
    expect(attr(html, "width")).toBe("24");
    expect(attr(html, "height")).toBe("24");
    expect(attr(html, "fill")).toBe("none");
    expect(attr(html, "stroke")).toBe("currentColor");
    expect(attr(html, "stroke-linecap")).toBe("round");
    expect(attr(html, "stroke-linejoin")).toBe("round");
    expect(attr(html, "xmlns")).toBe("http://www.w3.org/2000/svg");
  });

  it("renders the spec's stroke weight from lucide's DEFAULT — no per-call-site prop", () => {
    // The spec's `stroke-width="1.32"` sits inside `scale(1.515)`, so it draws
    // at 1.32 x 1.515 = 1.9998 user units. Folding the scale into the geometry
    // therefore lands the weight on lucide's own default of 2 (to 2/10000 of a
    // unit) — ~1.08px at the 13px byline, inside the ~1.85-2.2 band this spec's
    // other 13px glyphs occupy. If this ever needs an explicit strokeWidth, the
    // fold was done wrong.
    expect(attr(renderToStaticMarkup(<PlugConnectorKind />), "stroke-width")).toBe("2");
    expect(1.32 * 1.515).toBeCloseTo(2, 3);
  });

  it("carries the lucide class hooks so existing icon CSS reaches it", () => {
    const cls = (attr(renderToStaticMarkup(<PlugConnectorKind />), "class") ?? "").split(
      /\s+/,
    );
    expect(cls).toContain("lucide");
    expect(cls).toContain("lucide-plug-connector-kind");
  });

  it("is decorative by default (auto aria-hidden), like every lucide icon", () => {
    expect(attr(renderToStaticMarkup(<PlugConnectorKind />), "aria-hidden")).toBe(
      "true",
    );
  });
});

describe("PlugConnectorKind — prop-compatible with the lucide `Plug` it replaces", () => {
  it("forwards the kind-emblem className at BOTH extremes without dropping lucide classes", () => {
    // `extensionKindEmblem` styles purely by className, and the two ends of its
    // range are the 13px browse-card byline and the 34px detail-modal hero.
    for (const size of ["size-[13px]", "size-8.5"]) {
      const cls = (
        attr(renderToStaticMarkup(<PlugConnectorKind className={size} />), "class") ?? ""
      ).split(/\s+/);
      expect(cls).toEqual(expect.arrayContaining(["lucide", size]));
    }
  });

  it("inherits colour from its container (currentColor), like the arms beside it", () => {
    // The emblem sits on the accent-coloured pill and in the plum byline; it
    // must never carry a hard-coded stroke of its own.
    const html = renderToStaticMarkup(<PlugConnectorKind className="text-plum" />);
    expect(attr(html, "stroke")).toBe("currentColor");
    expect(html).not.toMatch(/stroke="#/);
    expect(PLUG_CONNECTOR_KIND_ICON_NODE.some(([, a]) => "stroke" in a || "fill" in a)).toBe(
      false,
    );
  });

  it("forwards size to BOTH width and height", () => {
    const html = renderToStaticMarkup(<PlugConnectorKind size={13} />);
    expect(attr(html, "width")).toBe("13");
    expect(attr(html, "height")).toBe("13");
  });

  it("forwards strokeWidth and color overrides", () => {
    const html = renderToStaticMarkup(
      <PlugConnectorKind strokeWidth={1.85} color="#fff" />,
    );
    expect(attr(html, "stroke-width")).toBe("1.85");
    expect(attr(html, "stroke")).toBe("#fff");
  });

  it("takes an accessible name when a call site chooses to expose it", () => {
    const html = renderToStaticMarkup(<PlugConnectorKind aria-label="Connector" />);
    expect(attr(html, "aria-label")).toBe("Connector");
    expect(attr(html, "aria-hidden")).toBeUndefined();
  });
});

describe("first-party glyph registry — build + export wiring", () => {
  it("is built with lucide's public factory (prop compatibility is structural, not asserted-by-hand)", () => {
    expect(iconsSrc).toMatch(
      /import \{ createLucideIcon, type IconNode, type LucideProps \} from "lucide-react"/,
    );
    expect(iconsSrc).toMatch(/createLucideIcon\(\s*"plug-connected"/);
    expect(iconsSrc).toMatch(/createLucideIcon\(\s*"plug-connector-kind"/);
    // No hand-rolled <svg> twin.
    expect(iconsSrc).not.toMatch(/<svg[\s>]/);
  });

  it("stayed a registry as it grew: every glyph is one exported node + one factory line", () => {
    // The second glyph landed the way the module's contract says it should
    // (cinatra#2364) — in here, not in a parallel module. These two counts
    // moving apart means someone added a component without its geometry export
    // (or vice versa), which is what the lock tests read from.
    // Anchored on the `export const` forms, not a bare `createLucideIcon(`:
    // the module header documents the two-line recipe in prose, and counting
    // that would make this assertion measure the comment.
    const nodes = iconsSrc.match(/export const [A-Z0-9_]+_ICON_NODE: IconNode/g) ?? [];
    const factories =
      iconsSrc.match(/export const [A-Za-z0-9]+ = createLucideIcon\(/g) ?? [];
    expect(nodes.length).toBe(factories.length);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    expect(iconsSrc).toMatch(/export const PLUG_CONNECTED_ICON_NODE: IconNode/);
    expect(iconsSrc).toMatch(/export const PLUG_CONNECTOR_KIND_ICON_NODE: IconNode/);
    expect(iconsSrc).toMatch(/export type CinatraIconProps = LucideProps/);
  });

  it("ships from its own `./icons` subpath, kept off the ratchet-locked root + marketplace barrels", () => {
    expect(pkg.exports["./icons"]).toBe("./src/icons.tsx");
    expect(indexSrc).not.toContain("./icons");
    expect(marketplaceSrc).not.toContain("./icons");
    for (const glyph of ["PlugConnected", "PlugConnectorKind"]) {
      expect(indexSrc).not.toContain(glyph);
      expect(marketplaceSrc).not.toContain(glyph);
    }
  });

  it("stays portable: no host `@/` alias, no root-barrel import", () => {
    expect(iconsSrc).not.toMatch(/from ["']@\//);
    // icons.tsx sits at the package src ROOT, so a barrel cycle would read
    // `./index` (or the self-referential package specifier) — NOT the
    // `../index` the src/ui/* primitives guard against. Guarding the wrong
    // form would be an assertion that can never fail.
    expect(iconsSrc).not.toMatch(/from ["']\.(?:\/index)?["']/);
    expect(iconsSrc).not.toMatch(/from ["']@cinatra-ai\/sdk-ui["']/);
  });

  it("README documents the subpath and every glyph in the registry", () => {
    const readme = readFileSync(join(PKG_DIR, "README.md"), "utf8");
    expect(readme).toContain(
      'import { PlugConnected } from "@cinatra-ai/sdk-ui/icons";',
    );
    expect(readme).toMatch(/\*\*`PlugConnected`\*\*/);
    expect(readme).toMatch(/\*\*`PlugConnectorKind`\*\*/);
  });
});
