// ---------------------------------------------------------------------------
// The S3 packaged-renderer reference target (cinatra#1222, epic #1216 S6).
//
// Renders the corpus through `@cinatra-ai/chat/renderer` — the reusable content
// renderer extracted in #1228 (S3) that `/chat` and the S5 embedded view both
// mount. Because this is the exact code path `/chat` renders through, it is the
// reference target: the DOM-normalized goldens are snapshots of its output and
// every future embedded/CMS target is compared against it.
//
// Content only. The S3 renderer covers the CONTENT layer (marked GFM, shiki,
// katex, and chart/mermaid DETECTION); the AG-UI event-to-UI interactive layer
// (tool-call chips, run cards, HITL, thinking groups, RUN_ERROR, the change-diff
// component) is the follow-up gated on S1's schema + S4's components and is not
// in the packaged renderer yet (#1228 scope note). The AG-UI corpus is therefore
// carried here as SCHEMA-locked wire fixtures (see render-parity.spec.ts), ready
// to plug into the render compare when S4 lands the components.
// ---------------------------------------------------------------------------

import {
  renderMarkdown,
  detectCharts,
  detectMermaidBlocks,
} from "@cinatra-ai/chat/renderer";

import type { ContentRenderResult, RenderTarget, RenderTheme } from "./target";

// The renderer requires a live widget detector (no default): the embedding host
// supplies its widget catalog's detector. The static corpus exercises no widget
// embeds, so the reference target supplies an empty detector — a widget-embed
// corpus is a live-run concern (the host catalog is an app-runtime dependency).
const noWidgets = () => [];

/**
 * The reference render target: the S3 packaged content renderer. `renderMarkdown`
 * is fully deterministic for a given (source, theme), so its output is a stable
 * golden and any drift in the shared renderer surfaces as a parity failure.
 */
export const packagedRendererTarget: RenderTarget = {
  id: "packaged-renderer",
  label: "S3 packaged renderer (@cinatra-ai/chat/renderer)",
  renderContent(source: string, theme: RenderTheme): ContentRenderResult {
    const html = renderMarkdown(source, theme, noWidgets);
    const charts = detectCharts(source).map((c) => ({ spec: c.spec, raw: c.raw }));
    const mermaid = detectMermaidBlocks(source).map((m) => ({ source: m.source }));
    return { html, charts, mermaid };
  },
};

/**
 * The registered targets driven by the harness. STATIC-FIXTURE SLICE: the
 * reference target only. The generic embedded view and the WordPress/Drupal
 * iframe targets register here in the live-run slice (after S2/S5) by adding a
 * `RenderTarget` — the corpus and compare logic are untouched.
 */
export const RENDER_TARGETS: readonly RenderTarget[] = [packagedRendererTarget];

/** The reference target every other target is compared against. */
export const REFERENCE_TARGET = packagedRendererTarget;
