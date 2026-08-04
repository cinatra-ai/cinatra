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
import { PlugConnected, PLUG_CONNECTED_ICON_NODE } from "../icons";

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

describe("first-party glyph registry — build + export wiring", () => {
  it("is built with lucide's public factory (prop compatibility is structural, not asserted-by-hand)", () => {
    expect(iconsSrc).toMatch(
      /import \{ createLucideIcon, type IconNode, type LucideProps \} from "lucide-react"/,
    );
    expect(iconsSrc).toMatch(/createLucideIcon\(\s*"plug-connected"/);
    // No hand-rolled <svg> twin.
    expect(iconsSrc).not.toMatch(/<svg[\s>]/);
  });

  it("is a registry, not a single-glyph file (a second glyph is one node + one factory line)", () => {
    expect(iconsSrc).toMatch(/export const PLUG_CONNECTED_ICON_NODE: IconNode/);
    expect(iconsSrc).toMatch(/export type CinatraIconProps = LucideProps/);
  });

  it("ships from its own `./icons` subpath, kept off the ratchet-locked root + marketplace barrels", () => {
    expect(pkg.exports["./icons"]).toBe("./src/icons.tsx");
    expect(indexSrc).not.toContain("./icons");
    expect(marketplaceSrc).not.toContain("./icons");
    expect(indexSrc).not.toContain("PlugConnected");
    expect(marketplaceSrc).not.toContain("PlugConnected");
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
