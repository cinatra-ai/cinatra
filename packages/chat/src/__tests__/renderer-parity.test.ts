// Zero-visual-regression guard for the #1219 (S3) renderer extraction.
//
// `/chat` swapped its content-renderer imports from the deep module paths
// (`./markdown-render`, `./chart-embed`, `./mermaid-block`, `./syntax-highlight`,
// `./chart-schema`) to the extracted public embed entry (`./renderer`). The
// extraction is a PURE re-export boundary, so this must hold for EVERY input:
//
//   1. Reference identity — the symbol re-exported from `./renderer` is the SAME
//      function/component instance the deep module exports. `/chat` therefore
//      runs byte-for-byte the same code; the barrel adds no wrapper, no behavior.
//   2. Byte identity — rendering a rich fixture conversation through the public
//      entry yields output identical to the pre-extraction path.
//
// If a future edit turns the barrel into anything other than a pure re-export
// (a wrapper, a transform, a divergent copy), this goes red — locking the
// "renders identically after extraction" acceptance criterion permanently.
import { describe, expect, it } from "vitest";

import * as barrel from "../renderer";
import { renderMarkdown as directRenderMarkdown, detectCharts as directDetectCharts, detectMermaidBlocks as directDetectMermaid } from "../markdown-render";
import { ChartEmbed as directChartEmbed, ChartError as directChartError } from "../chart-embed";
import { validateChart as directValidateChart } from "../chart-schema";
import { MermaidBlock as directMermaidBlock } from "../mermaid-block";
import { getHighlightedSync as directGetHighlightedSync, highlightCodeAsync as directHighlightCodeAsync } from "../syntax-highlight";

const noWidgets = () => [];

describe("renderer extraction parity (#1219 S3 — zero regression)", () => {
  it("re-exports the SAME instance for every content-renderer symbol", () => {
    // Reference identity == /chat runs the identical code through the barrel.
    expect(barrel.renderMarkdown).toBe(directRenderMarkdown);
    expect(barrel.detectCharts).toBe(directDetectCharts);
    expect(barrel.detectMermaidBlocks).toBe(directDetectMermaid);
    expect(barrel.ChartEmbed).toBe(directChartEmbed);
    expect(barrel.ChartError).toBe(directChartError);
    expect(barrel.validateChart).toBe(directValidateChart);
    expect(barrel.MermaidBlock).toBe(directMermaidBlock);
    expect(barrel.getHighlightedSync).toBe(directGetHighlightedSync);
    expect(barrel.highlightCodeAsync).toBe(directHighlightCodeAsync);
  });

  it("renders a rich fixture conversation byte-identically through the public entry", () => {
    // Exercises the render-parity checklist content items: headings, paragraphs,
    // nested lists, GFM table, inline + fenced code (language), links (external /
    // internal app-route / unsafe-dropped), image (unsafe-dropped), blockquote,
    // strikethrough, hr, KaTeX inline + display, raw HTML (escaped), broken fence.
    const fixture = [
      "# Quarterly report",
      "",
      "A **paragraph** with _emphasis_, `inline code`, ~~strikethrough~~, and a",
      "[safe external link](https://example.com) plus an [app link](/campaigns/42)",
      "and an [unsafe one](javascript:alert(1)).",
      "",
      "## Nested list",
      "",
      "- Top item",
      "  - Nested item with `code`",
      "  - Another nested",
      "- Second top",
      "",
      "1. First",
      "2. Second",
      "",
      "| Region | Revenue |",
      "| --- | --- |",
      "| EMEA | 1200 |",
      "| APAC | 980 |",
      "",
      "> A blockquote with a [link](https://example.org).",
      "",
      "```ts",
      "const x: number = 1;",
      "console.log(x);",
      "```",
      "",
      "Inline math $E = mc^2$ and display math:",
      "",
      "$$\\int_0^1 x^2 \\, dx = \\tfrac{1}{3}$$",
      "",
      "![unsafe image](javascript:alert(2))",
      "",
      "<script>alert('raw html')</script>",
      "",
      "```", // broken fence mid-stream
    ].join("\n");

    const viaPublic = barrel.renderMarkdown(fixture, "github-light", noWidgets);
    const viaDirect = directRenderMarkdown(fixture, "github-light", noWidgets);

    expect(viaPublic).toBe(viaDirect);
    // And the same across the dark code theme (shiki theme threads through).
    expect(barrel.renderMarkdown(fixture, "github-dark", noWidgets)).toBe(
      directRenderMarkdown(fixture, "github-dark", noWidgets),
    );

    // Embed detection (rendered beside the HTML) is identical through the entry.
    const chartSrc = '[chart:{"version":1,"type":"bar","title":"T","x":["a","b"],"series":[{"name":"s","data":[1,2]}]}]';
    expect(JSON.stringify(barrel.detectCharts(chartSrc))).toBe(JSON.stringify(directDetectCharts(chartSrc)));
    const mermaidSrc = "```mermaid\ngraph TD; A-->B;\n```";
    expect(JSON.stringify(barrel.detectMermaidBlocks(mermaidSrc))).toBe(JSON.stringify(directDetectMermaid(mermaidSrc)));
  });
});
