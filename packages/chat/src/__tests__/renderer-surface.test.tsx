// Export-surface guard for the reusable renderer module (cinatra#1219, S3).
//
// Pins the PUBLIC content-renderer surface exposed at `@cinatra-ai/chat/renderer`
// (the embed entry the Cinatra-served conversation-view / S5 iframe mounts). If a
// symbol is dropped or renamed, or the extracted entry stops rendering, this
// breaks — keeping the extraction boundary stable and the surface embeddable.
import { describe, expect, it } from "vitest";
import * as renderer from "../renderer";
import {
  renderMarkdown,
  detectCharts,
  detectMermaidBlocks,
  ChartEmbed,
  ChartError,
  MermaidBlock,
  validateChart,
  getHighlightedSync,
  highlightCodeAsync,
} from "../renderer";

const noWidgets = () => [];

describe("renderer module public surface (#1219 S3)", () => {
  it("exports the full content-renderer surface", () => {
    // Content functions.
    expect(typeof renderMarkdown).toBe("function");
    expect(typeof detectCharts).toBe("function");
    expect(typeof detectMermaidBlocks).toBe("function");
    expect(typeof validateChart).toBe("function");
    expect(typeof getHighlightedSync).toBe("function");
    expect(typeof highlightCodeAsync).toBe("function");
    // React renderable components (function components).
    expect(typeof ChartEmbed).toBe("function");
    expect(typeof ChartError).toBe("function");
    expect(typeof MermaidBlock).toBe("function");
    // Guard against accidental extra runtime exports creeping into the embed API.
    // Includes the S4 (#1220) renderable-view surface: the dispatcher, the
    // fallback, the component map, and each registered view card.
    const runtimeExports = Object.keys(renderer).sort();
    expect(runtimeExports).toEqual(
      [
        "ChartEmbed",
        "ChartError",
        "MermaidBlock",
        "detectCharts",
        "detectMermaidBlocks",
        "getHighlightedSync",
        "highlightCodeAsync",
        "renderMarkdown",
        "validateChart",
        // S4 renderable views (#1220).
        "RenderableViewCard",
        "RenderableViewFallback",
        "RENDERABLE_VIEW_COMPONENTS",
        "ContentChangeProposalCard",
        "ArtifactPreviewCard",
        "CitationGroupCard",
        "ChangeHistoryCard",
      ].sort(),
    );
  });

  it("renders markdown to HTML through the extracted entry", () => {
    const html = renderMarkdown("# Title\n\nHello **world**", "github-light", noWidgets);
    expect(html).toContain("Title");
    expect(html).toContain("<strong");
    expect(html).toContain("world");
  });

  it("keeps XSS hardening reachable through the public entry", () => {
    // Sanity that the hardened path — not a bypass — backs the public export.
    const html = renderMarkdown("[x](javascript:alert(1))", "github-light", noWidgets);
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/<a[^>]*href/i);
  });

  it("detects chart and mermaid embeds via the public entry", () => {
    const charts = detectCharts('[chart:{"version":1,"type":"bar","title":"T","x":["a"],"series":[{"name":"s","data":[1]}]}]');
    expect(charts).toHaveLength(1);
    expect(charts[0].spec).not.toBeNull();

    const mermaid = detectMermaidBlocks("```mermaid\ngraph TD; A-->B;\n```");
    expect(mermaid).toHaveLength(1);
    expect(mermaid[0].source).toContain("graph TD");
  });

  it("validates chart specs and rejects malformed ones", () => {
    expect(
      validateChart({ version: 1, type: "bar", title: "T", x: ["a"], series: [{ name: "s", data: [1] }] }),
    ).not.toBeNull();
    expect(validateChart({ nope: true })).toBeNull();
  });
});
