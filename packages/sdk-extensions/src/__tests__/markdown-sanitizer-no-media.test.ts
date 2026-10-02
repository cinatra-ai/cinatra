// ---------------------------------------------------------------------------
// THE NO-MEDIA MODE of the markdown sanitizer leaf (enabler 0.5 of
// `PLAN: Agents Lifecycle (C)`, the W9 blog displays).
//
// WHY IT EXISTS. The ruling on the blog pipeline is that the pipeline makes ONE
// picture, the featured image, and that a text display draws no picture at all:
// "a text view renders text". But the shared sanitizer draws an image for an
// absolute-address markdown image, so each of the three blog text displays had
// to wrap the sanitizer's own output and strip the image node itself — three
// copies of a removal step, downstream of the one boundary that is supposed to
// decide what markdown may emit.
//
// So the rule gets a durable home HERE, on the leaf: a caller may ask for no
// media, and the sanitizer emits none. The placeholder a refused address
// already produces is what a no-media render emits for EVERY image — one
// behaviour, one code path, no second boundary.
//
// The DEFAULT mode is unchanged, and that is asserted just as hard: the README
// surface and every other existing caller render byte-identically.
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";

import { renderSanitizedMarkdown } from "../markdown-sanitizer";

const ABSOLUTE_IMAGE = "![a photograph](https://example.com/picture.png)";

describe("the sanitizer's no-media mode", () => {
  it("emits NO image node for an absolute-address markdown image", () => {
    const out = renderSanitizedMarkdown(ABSOLUTE_IMAGE, { noMedia: true });
    expect(out).not.toContain("<img");
    expect(out).not.toContain("https://example.com/picture.png");
  });

  it("keeps the picture's name as readable text, the way a refused address already does", () => {
    const out = renderSanitizedMarkdown(ABSOLUTE_IMAGE, { noMedia: true });
    expect(out).toContain("[image]");
    expect(out).toContain("a photograph");
  });

  it("leaves the DEFAULT mode drawing the picture — the boundary is unchanged", () => {
    const out = renderSanitizedMarkdown(ABSOLUTE_IMAGE);
    expect(out).toContain("<img");
    expect(out).toContain('src="https://example.com/picture.png"');
    expect(renderSanitizedMarkdown(ABSOLUTE_IMAGE, { noMedia: false })).toBe(out);
  });

  it("removes only the media — text, headings and links render identically", () => {
    const md = "# Title\n\nSee [the source](https://example.com/x) for more.\n";
    expect(renderSanitizedMarkdown(md, { noMedia: true })).toBe(renderSanitizedMarkdown(md));
  });

  it("composes with heading demotion instead of replacing it", () => {
    const md = `# Title\n\n${ABSOLUTE_IMAGE}\n`;
    const out = renderSanitizedMarkdown(md, { demoteHeadings: true, noMedia: true });
    expect(out).toContain("<h2>");
    expect(out).not.toContain("<h1>");
    expect(out).not.toContain("<img");
  });

  it("still refuses a non-http address in no-media mode, with the same placeholder", () => {
    const out = renderSanitizedMarkdown("![alt](data:image/png;base64,AAAA)", { noMedia: true });
    expect(out).not.toContain("data:image");
    expect(out).toContain("[image]");
  });

  it("emits no image for a reference-style absolute address either", () => {
    const md = "![the hero][hero]\n\n[hero]: https://example.com/hero.png\n";
    expect(renderSanitizedMarkdown(md, { noMedia: true })).not.toContain("<img");
    expect(renderSanitizedMarkdown(md)).toContain("<img");
  });
});
