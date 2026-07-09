// Reusable conversation CONTENT renderer — the public, embeddable module.
// -----------------------------------------------------------------------------
// cinatra#1219 (S3 of the unified-assistant-stream epic #1216) extracts the
// `/chat` transcript CONTENT renderer into a reusable module so every surface —
// first-party `/chat` and the Cinatra-served embedded conversation-view that
// the CMS widgets mount (S5's iframe target) — renders through ONE shared code
// path. Rendering identically becomes definitional, not a property each surface
// re-implements.
//
// This barrel is the package's public embed entry, exposed as the
// `@cinatra-ai/chat/renderer` subpath (see package.json "exports"). It is a
// pure re-export boundary: every symbol below is the SAME module instance the
// renderer has always used, so `/chat` renders byte-identically after the
// extraction (zero visual regression — the barrel adds no behavior).
//
// SCOPE — content renderer only. This module covers the content layer:
//   marked (GFM) · shiki (theme-aware syntax highlight) · katex (math) ·
//   mermaid · recharts · inline chart/widget embeds — all XSS-hardened
//   (escapeHtml + safeHref scheme-allowlist inside markdown-render).
// It is already decoupled from the bespoke `chat-stream-events` vocabulary:
// `renderMarkdown(text, theme, detectWidgets)` knows nothing about the wire.
//
// NOT YET HERE — the AG-UI event-to-UI reducer + interactive layer (tool-call
// chips, inline run cards, HITL, citations, thinking groups, streaming/partial
// states, RUN_ERROR). That half is the piece coupled to `chat-stream-events`
// today; it moves in a FOLLOW-UP gated on S1 (#1217), which defines the
// versioned AG-UI event schema the reducer consumes. See README.md.

// --- Markdown → HTML content renderer (marked GFM, XSS-hardened) -------------
export {
  renderMarkdown,
  detectCharts,
  detectMermaidBlocks,
  type DetectedChart,
  type MermaidSource,
} from "../markdown-render";

// --- Recharts chart embeds (validated ChartSpec) -----------------------------
export { ChartEmbed, ChartError } from "../chart-embed";
export { validateChart, type ChartSpec } from "../chart-schema";

// --- Mermaid diagram block (lazy-loads mermaid on first render) ---------------
export { MermaidBlock } from "../mermaid-block";

// --- Shiki syntax highlighting (lazy-loaded; sync cache + async hydrate) ------
export {
  getHighlightedSync,
  highlightCodeAsync,
  type ThemeName,
} from "../syntax-highlight";

// --- Widget detector contract ------------------------------------------------
// `renderMarkdown` requires a live widget detector (no default): the embedding
// host supplies its widget catalog's detector so a missing catalog is a compile
// error, not a silently-dead widget surface.
export type { DetectedWidget } from "../widget-runtime";
