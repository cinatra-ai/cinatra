// ---------------------------------------------------------------------------
// Render-parity target seam (cinatra#1222, epic #1216 S6).
//
// The render-parity conformance harness renders one fixture corpus through a
// set of TARGETS and fails on divergence, so "exactly like /chat" cannot
// silently drift across surfaces. A `RenderTarget` is any surface that can turn
// the corpus's content markdown into HTML and enumerate its side-embeds.
//
// STATIC-FIXTURE SLICE (this PR): the only registered target is the S3 packaged
// renderer (`@cinatra-ai/chat/renderer`, merged in #1228) — it IS the reference
// surface `/chat` renders through, so it is both the corpus author's reference
// and the parity baseline. The DOM-normalized goldens under `__goldens__/` are
// snapshots of this target's output; the spec re-renders and fails on drift.
//
// LIVE-RUN SLICE (out of scope here — after S2 `/chat` on the wire and S5
// widgets embedded): the generic Cinatra embedded conversation-view and each
// CMS-hosted iframe (WordPress, Drupal) register as additional `RenderTarget`s
// that drive the SAME corpus through their real running surface, and the
// harness asserts every target's DOM-normalized output equals the reference
// target's. The #1214 no-direct-egress assertion joins that embedded E2E.
// Those targets plug in here WITHOUT touching the corpus or the compare logic —
// they only implement this interface.
// ---------------------------------------------------------------------------

import type { ChartSpec } from "@cinatra-ai/chat/renderer";

/** A chart embed detected in the source, with its validated spec (or null). */
export type DetectedChartEmbed = {
  readonly spec: ChartSpec | null;
  readonly raw: string;
};

/** A mermaid block detected in the source. */
export type DetectedMermaidEmbed = {
  readonly source: string;
};

/**
 * The result of rendering one content fixture through a target: the inline HTML
 * plus the side-embeds the renderer extracts and mounts separately (charts and
 * mermaid diagrams are stripped from the markdown HTML and rendered as React
 * components beside it — exactly as `/chat` does).
 */
export type ContentRenderResult = {
  /** Inline markdown HTML (charts/mermaid stripped, math/code inlined). */
  readonly html: string;
  /** Chart embeds detected + schema-validated, in document order. */
  readonly charts: readonly DetectedChartEmbed[];
  /** Mermaid blocks detected, in document order. */
  readonly mermaid: readonly DetectedMermaidEmbed[];
};

/** A theme the renderer threads through (shiki code theme + token classes). */
export type RenderTheme = "github-light" | "github-dark";

/**
 * A surface the corpus can be rendered through. The reference target (the S3
 * packaged renderer) and every later embedded/CMS target implement this — the
 * harness stays surface-agnostic.
 */
export type RenderTarget = {
  /** Stable id, e.g. `"packaged-renderer"`, `"embedded-view"`, `"wordpress-iframe"`. */
  readonly id: string;
  /** Human label for reports. */
  readonly label: string;
  /** Render one content markdown source at a theme into HTML + side-embeds. */
  renderContent(source: string, theme: RenderTheme): ContentRenderResult;
};
