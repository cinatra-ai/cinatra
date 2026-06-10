/**
 * MarketplaceReadmeMarkdownSection — the README primary body of the in-app
 * marketplace detail view, rendering the marketplace-sourced
 * `ExtensionDetail.readmeMarkdown` with public-page parity. Covers:
 *   - markdown rendered through the sanitizing renderer (raw HTML stripped,
 *     unsafe link schemes dropped)
 *   - headings demoted one level (README `# Title` renders as <h2> — the page
 *     hero owns the only <h1>)
 *   - the scoped editorial typography contract: ~65ch reading measure, an
 *     explicit size/weight class per heading level, list styling, and inline
 *     code + fenced code-block styling
 *   - empty/absent markdown renders no section at all (no empty pane), and
 *     markdown that sanitizes down to nothing also renders no section
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MARKETPLACE_README_BODY_CLASS,
  MarketplaceReadmeMarkdownSection,
  hasRenderableReadmeMarkdown,
} from "../marketplace-readme-section";

describe("MarketplaceReadmeMarkdownSection — rendering", () => {
  it("renders markdown into the Description slot with the readme body container", () => {
    const html = renderToStaticMarkup(
      <MarketplaceReadmeMarkdownSection markdown={"# Acme Widget\n\nDoes things."} />,
    );
    expect(html).toContain('data-slot="marketplace-readme"');
    expect(html).toContain(">Description<");
    expect(html).toContain('data-slot="extension-readme"');
    expect(html).toContain("Does things.");
  });

  it("demotes the README's own h1 below the page heading level", () => {
    const html = renderToStaticMarkup(
      <MarketplaceReadmeMarkdownSection markdown={"# Acme Widget\n\n## Usage"} />,
    );
    // The section heading ("Description") is the only h2-level element the
    // slot itself contributes; the README's `# Acme Widget` must arrive as
    // <h2> (never <h1>) and `## Usage` as <h3>.
    expect(html).toContain("<h2>Acme Widget</h2>");
    expect(html).toContain("<h3>Usage</h3>");
    expect(html).not.toContain("<h1");
  });

  it("sanitizes vendor markdown (raw HTML stripped, unsafe schemes dropped)", () => {
    const html = renderToStaticMarkup(
      <MarketplaceReadmeMarkdownSection
        markdown={"# T\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))"}
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });
});

describe("MarketplaceReadmeMarkdownSection — empty handling (no empty pane)", () => {
  it.each([null, undefined, "", "   \n\t  "])(
    "renders nothing for %j markdown",
    (markdown) => {
      const html = renderToStaticMarkup(
        <MarketplaceReadmeMarkdownSection markdown={markdown} />,
      );
      expect(html).toBe("");
    },
  );

  it("renders nothing when the markdown sanitizes down to empty output", () => {
    // A README consisting solely of raw HTML is stripped to nothing by the
    // sanitizing renderer — the section must not render an empty pane.
    const html = renderToStaticMarkup(
      <MarketplaceReadmeMarkdownSection markdown={"<div><script>x</script></div>"} />,
    );
    expect(html).toBe("");
  });
});

describe("hasRenderableReadmeMarkdown — fallback decision helper", () => {
  it("is true for markdown that renders visible output", () => {
    expect(hasRenderableReadmeMarkdown("# Title\n\nBody.")).toBe(true);
    expect(hasRenderableReadmeMarkdown("plain text")).toBe(true);
  });

  it.each([null, undefined, "", "   \n\t  "])(
    "is false for %j markdown",
    (markdown) => {
      expect(hasRenderableReadmeMarkdown(markdown)).toBe(false);
    },
  );

  it("is false when the markdown sanitizes down to nothing (raw HTML only)", () => {
    expect(hasRenderableReadmeMarkdown("<div><script>x</script></div>")).toBe(false);
  });
});

describe("MARKETPLACE_README_BODY_CLASS — editorial typography contract", () => {
  it("caps the reading measure at ~65ch like the public .cin-ext-readme", () => {
    expect(MARKETPLACE_README_BODY_CLASS).toContain("max-w-[65ch]");
  });

  it("defines an explicit size and weight per heading level (post-demotion h2–h6)", () => {
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h2]:text-xl");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h2]:font-semibold");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h3]:text-lg");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h3]:font-semibold");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h4]:text-base");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h4]:font-semibold");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h5]:text-sm");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h5]:font-semibold");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h6]:text-sm");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_h6]:font-medium");
  });

  it("styles unordered and ordered lists with markers and indentation", () => {
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_ul]:list-disc");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_ul]:pl-6");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_ol]:list-decimal");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_ol]:pl-6");
  });

  it("styles inline code chips and fenced code blocks (with the chip reset inside pre)", () => {
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_code]:bg-surface-muted");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_code]:font-mono");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_pre]:overflow-x-auto");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_pre]:bg-surface-muted");
    expect(MARKETPLACE_README_BODY_CLASS).toContain("[&_pre_code]:bg-transparent");
  });

  it("is applied to the readme body container", () => {
    const html = renderToStaticMarkup(
      <MarketplaceReadmeMarkdownSection markdown={"plain text"} />,
    );
    expect(html).toContain("max-w-[65ch]");
  });
});
