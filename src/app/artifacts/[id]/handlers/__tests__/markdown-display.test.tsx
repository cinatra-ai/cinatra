/**
 * THE MARKDOWN DISPLAY IS TWO TABS, AND ONLY ONE OF THEM IS ON SCREEN
 * (cinatra#2934, fix leg 10).
 *
 * The ratified review drawing fixes the display: "Markdown is drawn by a display
 * of its own, and that display carries two tabs — Code and Preview. Only the
 * active tab's view is shown … They are never drawn side by side, and there is no
 * third reading." On a review target the same display is drawn read-only, "both
 * tabs, neither editable", and it "opens on Preview, with Code one press away".
 *
 * The handler drew a two-column grid ("Rendered" beside "Raw source") — both
 * readings at once, which is the one thing the drawing forbids.
 *
 * Rendered with `renderToStaticMarkup` (the repo's node-environment pattern), so
 * this pins the display's OPENING reading: the tab strip, the active tab, and the
 * single panel under it.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownDisplay } from "../markdown-display";

const RAW = "# Heading\n\nA body line.";
const HTML = "<h1>Heading</h1>\n<p>A body line.</p>";

function draw() {
  return renderToStaticMarkup(<MarkdownDisplay raw={RAW} html={HTML} />);
}

describe("the markdown display", () => {
  it("draws a tab strip with exactly two tabs, Code and Preview", () => {
    const markup = draw();
    expect(markup).toContain('role="tablist"');
    expect((markup.match(/role="tab"/g) ?? []).length).toBe(2);
    expect(markup).toContain(">Code<");
    expect(markup).toContain(">Preview<");
  });

  it("opens on Preview, with Code one press away", () => {
    const markup = draw();
    expect(markup).toMatch(/aria-selected="true"[^>]*>Preview</);
    expect(markup).toMatch(/aria-selected="false"[^>]*>Code</);
  });

  it("draws only the active tab's view — the two are never side by side", () => {
    const markup = draw();
    // Two panels, and exactly ONE of them on screen: the inactive one is
    // `hidden` and holds nothing at all.
    expect((markup.match(/role="tabpanel"/g) ?? []).length).toBe(2);
    expect((markup.match(/data-state="active"[^>]*role="tabpanel"/g) ?? []).length +
      (markup.match(/role="tabpanel"[^>]*data-state="active"/g) ?? []).length).toBe(1);
    expect(markup).toMatch(/role="tabpanel"[^>]*hidden/);
    expect(markup).toContain("A body line.");
    // The Code view's own text is not on screen while Preview is active.
    expect(markup).not.toContain("# Heading");
    // and the retired side-by-side headings are gone for good
    expect(markup).not.toContain("Raw source");
    expect(markup).not.toContain("Rendered");
    expect(markup).not.toMatch(/md:grid-cols-2/);
  });

  it("is read-only — neither tab offers an edit", () => {
    const markup = draw();
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("contenteditable");
  });
});
