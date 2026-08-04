import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

// The sdk-ui vitest env is `node` (no DOM render — see the Tabs +
// connection-status primitive tests). This is a module-load render smoke
// (react-dom/server works fine without a DOM) + source-text contract over
// the connector-kind glyph (cinatra#2364, epic #2360): the lower-half-plug
// mark that supersedes the app's prior lucide `Plug` kind emblem.

const SRC_DIR = join(__dirname, "..");
const PKG_DIR = join(SRC_DIR, "..", "..");
const glyphSrc = readFileSync(join(SRC_DIR, "plug-connector-kind.tsx"), "utf8");
const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as {
  exports: Record<string, string>;
};

describe("PlugConnectorKind glyph — module load + render", () => {
  it("loads and exports a component that renders without throwing", async () => {
    const mod = await import("../plug-connector-kind");
    expect(typeof mod.PlugConnectorKind).toBe("function");
    const html = renderToStaticMarkup(<mod.PlugConnectorKind />);
    expect(html).toContain("<svg");
    expect(html).toContain('viewBox="0 0 24 24"');
  });

  it.each(["size-[13px]", "size-[34px]"])(
    "forwards the %s className to the rendered <svg> (both required render sizes)",
    async (sizeClass) => {
      const { PlugConnectorKind } = await import("../plug-connector-kind");
      const html = renderToStaticMarkup(<PlugConnectorKind className={sizeClass} />);
      expect(html).toContain(`class="${sizeClass}"`);
    },
  );

  it("forwards a caller strokeWidth override to BOTH the root <svg> and the nested drawing group (lucide-compatible call sites)", async () => {
    const { PlugConnectorKind } = await import("../plug-connector-kind");
    const html = renderToStaticMarkup(<PlugConnectorKind className="size-[13px]" strokeWidth={2.2} />);
    expect(html).toContain('class="size-[13px]"');
    // The paths inherit stroke-width from the nested <g>, not the root <svg> —
    // a caller override that only reached the root would change the markup
    // but have zero visual effect on the drawn glyph. Both must carry it.
    const svgStrokeWidth = html.match(/^<svg[^>]*stroke-width="([^"]+)"/);
    const groupStrokeWidth = html.match(/<g[^>]*stroke-width="([^"]+)"/);
    expect(svgStrokeWidth?.[1]).toBe("2.2");
    expect(groupStrokeWidth?.[1]).toBe("2.2");
  });

  it("inherits currentColor (never a hard-coded stroke colour)", () => {
    expect(glyphSrc).toContain('stroke="currentColor"');
    expect(glyphSrc).not.toMatch(/stroke="#[0-9a-fA-F]/);
  });

  it("recentres/rescales the lower-plug-half drawing across the full 24-unit viewBox (not a literal crop)", () => {
    // The ratified card spec's own transform for this glyph — pinning the
    // exact recentre/rescale, not just "some transform exists".
    expect(glyphSrc).toContain('transform="translate(-1.03,-11.33) scale(1.515)"');
  });

  it("is exported from the sdk-ui package as a dedicated subpath (single glyph-module owner)", () => {
    expect(pkg.exports["./icons/plug-connector-kind"]).toBe("./src/icons/plug-connector-kind.tsx");
  });
});
