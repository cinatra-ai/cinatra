/**
 * First-party glyph registry (`@cinatra-ai/sdk-ui/icons`) — cinatra#2356.
 *
 * Unlike the other sdk-ui suites in this folder (source-text contracts), this
 * one RENDERS: the whole point of the glyph is the drawing, and the drawing is
 * a spec deliverable. The root vitest env is "node", so it renders through
 * `react-dom/server` — enough to prove the emitted SVG, its geometry, and the
 * prop forwarding that makes the component a drop-in at lucide call sites.
 *
 * The expected path set below is the spec's own, copied VERBATIM from
 * design/specs/app-connectors.html version 0.7.0 (pinned at design@3d33cc800), where
 * the joined plug is drawn 15 times (toggle segment, card badges, §II status
 * cards/rows, the Connect action) from ONE invariant four-path set. Keeping it
 * literal here is deliberate: this is the redraw-identity lock, so a "cleanup"
 * that nudged a control point would go red instead of silently shipping a
 * different mark.
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

// ---------------------------------------------------------------------------
// PlugConnectorKind — the "connector" KIND emblem (cinatra#2364, epic #2360).
//
// The ratified card spec draws this glyph as four paths inside
// `<g transform="translate(-1.03,-11.33) scale(1.515)" stroke-width="1.32">`
// under a 1.85-stroke root. The registry entry BAKES that transform into the
// path coordinates (a flat `IconNode` carries neither nested groups nor
// dynamic per-node attributes, and a per-path transform would multiply the
// drawn stroke by the 1.515 scale — see icons.tsx). The block below is the
// redraw-identity lock for that derivation: it recomputes the baked strings
// from the spec's own PRE-transform drawing and compares them literally, so a
// nudged control point or a mis-applied map goes red instead of silently
// shipping a different mark.
// ---------------------------------------------------------------------------

/** The spec's group transform: (x, y) → (s·x + tx, s·y + ty), deltas/radii ×s. */
const KIND_TRANSFORM = { tx: -1.03, ty: -11.33, scale: 1.515 } as const;
/** The spec's stroke calibration: group 1.32 under a 1.85 root. */
const KIND_SPEC_STROKE = { root: 1.85, group: 1.32 } as const;

const kfmt = (n: number) => String(Math.round(n * 1e4) / 1e4);
const kabs = ([x, y]: readonly [number, number]) =>
  `${kfmt(KIND_TRANSFORM.scale * x + KIND_TRANSFORM.tx)} ${kfmt(KIND_TRANSFORM.scale * y + KIND_TRANSFORM.ty)}`;
const krel = ([dx, dy]: readonly [number, number]) =>
  `${kfmt(KIND_TRANSFORM.scale * dx)} ${kfmt(KIND_TRANSFORM.scale * dy)}`;
const krad = (r: number) => kfmt(KIND_TRANSFORM.scale * r);

/**
 * The spec's four pre-transform paths, transcribed command by command —
 * cord `m2 22 6-6`; socket half `M9.3 17.3a2.4 2.4 0 0 0 3.4 0L15 15l-6-6
 * -2.3 2.3a2.4 2.4 0 0 0 0 3.4Z`; prong stubs `M10.5 10.5 13 8` and
 * `M13.5 13.5 16 11` — pushed through the affine map above and serialized in
 * the canonical form icons.tsx commits (absolute initial moveto, explicit
 * command letters, space-separated args, 4-decimal rounding).
 */
const KIND_SPEC_PATHS_BAKED = [
  `M${kabs([2, 22])}l${krel([6, -6])}`,
  `M${kabs([9.3, 17.3])}a${krad(2.4)} ${krad(2.4)} 0 0 0 ${krel([3.4, 0])}L${kabs([15, 15])}l${krel([-6, -6])}l${krel([-2.3, 2.3])}a${krad(2.4)} ${krad(2.4)} 0 0 0 ${krel([0, 3.4])}Z`,
  `M${kabs([10.5, 10.5])}L${kabs([13, 8])}`,
  `M${kabs([13.5, 13.5])}L${kabs([16, 11])}`,
];

describe("PlugConnectorKind — the spec drawing, derivation-locked", () => {
  it("draws exactly the spec's four transformed paths, in the spec's order", () => {
    const html = renderToStaticMarkup(<PlugConnectorKind />);
    expect(dsOf(html)).toEqual(KIND_SPEC_PATHS_BAKED);
    expect(html.match(/<path/g)).toHaveLength(4);
    expect(html).not.toMatch(/<(circle|rect|line|polyline|polygon|ellipse|g)[\s/>]/);
  });

  it("exports the baked path set so a consumer/lock can assert geometry without rendering", () => {
    expect(PLUG_CONNECTOR_KIND_ICON_NODE.map(([tag]) => tag)).toEqual([
      "path",
      "path",
      "path",
      "path",
    ]);
    expect(PLUG_CONNECTOR_KIND_ICON_NODE.map(([, a]) => a.d)).toEqual(
      KIND_SPEC_PATHS_BAKED,
    );
  });

  it("is the KIND glyph, not the STATUS glyph — the two path sets share nothing", () => {
    const kindDs = PLUG_CONNECTOR_KIND_ICON_NODE.map(([, a]) => a.d);
    for (const d of kindDs) expect(SPEC_PATHS).not.toContain(d);
  });

  it("carries the transform in its coordinates: no transform and no per-path stroke-width in the markup", () => {
    // The baked-geometry contract (see icons.tsx): the paths inherit the ROOT
    // stroke directly, so lucide's stroke semantics (strokeWidth /
    // absoluteStrokeWidth) apply to the drawn glyph unscaled.
    const html = renderToStaticMarkup(<PlugConnectorKind />);
    expect(html).not.toContain("transform=");
    expect(html.match(/<path[^>]*stroke-width/)).toBeNull();
  });
});

describe("PlugConnectorKind — stroke calibration (the spec's 1.85/1.32 ratio, under lucide chrome)", () => {
  it("lucide's default stroke reproduces the spec's calibrated drawn weight (group × scale ≈ 2)", () => {
    // The identity that makes the baked entry stroke-exact: the spec draws the
    // glyph at group 1.32 under the 1.515 scale — a drawn weight of 1.99998,
    // i.e. lucide's own default stroke-width of 2 to 0.01%. Asserted, not
    // assumed, so a recalibrated spec pair goes red here instead of silently
    // rendering off-weight.
    expect(KIND_SPEC_STROKE.group * KIND_TRANSFORM.scale).toBeCloseTo(2, 3);
    expect(attr(renderToStaticMarkup(<PlugConnectorKind />), "stroke-width")).toBe("2");
  });

  it("a caller strokeWidth override scales the DRAWN glyph proportionally (root carries it, no path overrides it)", () => {
    // The fix over the predecessor single-file component, which forwarded the
    // caller value onto the drawing group UNDER the 1.515 scale (an override
    // of 2.2 painted at ~3.33). Here the override lands on the root, the
    // paths inherit it, and nothing rescales it. (Residual vs a strict
    // root:group ratio reading — ×1.0 instead of ×1.081 on overrides — is
    // documented at the definition; the ratio itself is pinned above.)
    const html = renderToStaticMarkup(<PlugConnectorKind strokeWidth={2.2} />);
    expect(attr(html, "stroke-width")).toBe("2.2");
    expect(html.match(/<path[^>]*stroke-width/)).toBeNull();
    expect(KIND_SPEC_STROKE.group / KIND_SPEC_STROKE.root).toBeCloseTo(1.32 / 1.85, 10);
  });
});

describe("PlugConnectorKind — prop-compatible at every kind-emblem call site", () => {
  it.each(["size-[13px]", "size-[34px]"])(
    "forwards the %s className alongside the lucide class hooks (both required render sizes)",
    (sizeClass) => {
      const html = renderToStaticMarkup(<PlugConnectorKind className={sizeClass} />);
      const cls = (attr(html, "class") ?? "").split(/\s+/);
      expect(cls).toEqual(
        expect.arrayContaining(["lucide", "lucide-plug-connector-kind", sizeClass]),
      );
    },
  );

  it("renders lucide-identical chrome: currentColor stroke, 24x24 box, decorative by default", () => {
    const html = renderToStaticMarkup(<PlugConnectorKind />);
    expect(attr(html, "stroke")).toBe("currentColor");
    expect(attr(html, "viewBox")).toBe("0 0 24 24");
    expect(attr(html, "fill")).toBe("none");
    expect(attr(html, "aria-hidden")).toBe("true");
  });

  it("forwards size to BOTH width and height", () => {
    const html = renderToStaticMarkup(<PlugConnectorKind size={13} />);
    expect(attr(html, "width")).toBe("13");
    expect(attr(html, "height")).toBe("13");
  });
});

describe("first-party glyph registry — build + export wiring", () => {
  it("is built with lucide's public factory (prop compatibility is structural, not asserted-by-hand)", () => {
    expect(iconsSrc).toMatch(
      /import \{ createLucideIcon, type IconNode, type LucideProps \} from "lucide-react"/,
    );
    expect(iconsSrc).toMatch(/createLucideIcon\(\s*"plug-connected"/);
    // No hand-rolled <svg> twin.
    expect(iconsSrc).not.toMatch(/<svg[\s>]/);
  });

  it("is a registry, not a single-glyph file — and the second glyph IS one node + one factory line", () => {
    expect(iconsSrc).toMatch(/export const PLUG_CONNECTED_ICON_NODE: IconNode/);
    expect(iconsSrc).toMatch(/export const PLUG_CONNECTOR_KIND_ICON_NODE: IconNode/);
    expect(iconsSrc).toMatch(/createLucideIcon\(\s*"plug-connector-kind"/);
    expect(iconsSrc).toMatch(/export type CinatraIconProps = LucideProps/);
  });

  it("ships from its own `./icons` subpath, kept off the ratchet-locked root + marketplace barrels", () => {
    expect(pkg.exports["./icons"]).toBe("./src/icons.tsx");
    expect(indexSrc).not.toContain("./icons");
    expect(marketplaceSrc).not.toContain("./icons");
    expect(indexSrc).not.toContain("PlugConnected");
    expect(marketplaceSrc).not.toContain("PlugConnected");
  });

  it("is the SINGLE glyph-module owner: `./icons` is the only icons subpath (cinatra#2364)", () => {
    // The parallel-module shape this locks out: a sibling glyph file under
    // src/icons/ with its own `./icons/<name>` subpath export. Every
    // first-party mark ships from THIS registry, through THIS subpath.
    const iconExportKeys = Object.keys(pkg.exports).filter((k) =>
      k.startsWith("./icons"),
    );
    expect(iconExportKeys).toEqual(["./icons"]);
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

  it("README documents the subpath and the glyph", () => {
    const readme = readFileSync(join(PKG_DIR, "README.md"), "utf8");
    expect(readme).toContain(
      'import { PlugConnected } from "@cinatra-ai/sdk-ui/icons";',
    );
    expect(readme).toMatch(/\*\*`PlugConnected`\*\*/);
  });
});
