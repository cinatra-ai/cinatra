/**
 * Markdown sanitization regression tests.
 *
 * The artifact-detail markdown handler renders raw artifact bytes
 * through the canonical `renderReadmeMarkdown` constrained renderer.
 * These tests guard that swap: marked@18 alone does NOT sanitize,
 * `renderReadmeMarkdown` does. If a future refactor swaps back to a
 * raw `marked.parse` call (or to a different renderer that admits
 * raw HTML), these tests fail and the regression is caught in CI.
 *
 * Threat model: a malicious artifact author injects raw `<script>`,
 * inline event handlers, or `javascript:` URLs into the markdown
 * source. The renderer MUST drop or escape all three so nothing
 * executes inside the Cinatra origin under the viewing user's
 * identity.
 */
import { describe, expect, it } from "vitest";

import { renderReadmeMarkdown } from "@cinatra-ai/agents/readme-render";

describe("artifact markdown renderer — sanitization", () => {
  it("drops raw <script> blocks", () => {
    const html = renderReadmeMarkdown("hello\n\n<script>alert(1)</script>\n\nworld");
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("hello");
    expect(html).toContain("world");
  });

  it("strips inline event handlers from raw HTML elements", () => {
    const html = renderReadmeMarkdown(
      'before\n\n<img src="x" onerror="alert(1)">\n\nafter',
    );
    expect(html).not.toMatch(/onerror=/i);
  });

  it("rewrites javascript: link hrefs", () => {
    const html = renderReadmeMarkdown(
      "click [me](javascript:alert(1)) ok",
    );
    expect(html).not.toMatch(/javascript:/i);
  });

  it("drops raw <svg onload> from artifact content", () => {
    const html = renderReadmeMarkdown(
      "icon\n\n<svg onload=alert(1)><circle r=10/></svg>\n\n",
    );
    expect(html).not.toMatch(/onload=/i);
    // Either the <svg> tag is stripped or its event handlers are.
  });

  it("renders safe markdown structure intact (smoke)", () => {
    const html = renderReadmeMarkdown(
      "# Heading\n\n**bold** and _italic_\n\n- one\n- two\n",
    );
    expect(html).toMatch(/<h1/i);
    expect(html).toMatch(/<strong/i);
    expect(html).toMatch(/<ul/i);
  });
});
