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
// NOT IN THIS BARREL — the AG-UI event-to-UI reducer + interactive layer
// (tool-call chips, inline run cards, HITL, citations, thinking groups,
// streaming/partial states, RUN_ERROR, and the S4 renderable-view dispatch of
// the reducer's carried-through dataParts). That half LANDED (the follow-up
// gated on S1 #1217) and is deliberately exposed at its OWN subpaths —
// `@cinatra-ai/chat/renderer/ag-ui-reducer` and
// `@cinatra-ai/chat/renderer/ag-ui-interactive` — so this content barrel's
// embed API stays minimal (see the export-surface guard test). See README.md.

// --- Markdown → HTML content renderer (marked GFM, XSS-hardened) -------------
export {
  renderMarkdown,
  detectCharts,
  detectMermaidBlocks,
  type DetectedChart,
  type MermaidSource,
} from "../markdown-render";

// --- Chart payload contract (host-owned; the `chart` renderable-view COMPONENT
// migrated to @cinatra-ai/chart-artifact via the generated cinatra.views map,
// cinatra#1626 — recharts + ChartEmbed no longer ship from this package) -------
export { validateChart, type ChartSpec } from "@cinatra-ai/agent-ui-protocol/renderable-views/chart";

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

// --- Renderable views (S4, #1220) --------------------------------------------
// First-class assistant-specific views carried as typed `DATA_PART` payloads on
// the one wire (change-diff / content_change_proposal, artifact previews,
// citation groups, change history). `RenderableViewCard` is the single dispatch
// entry: it validates+sanitizes a raw payload via the S1/S4 schema registry and
// renders the registered component, or a safe fallback for an unknown/invalid
// view. Registering a view is a schema entry (@cinatra-ai/agent-ui-protocol) +
// a component entry — no surface forks. NOTE: display-only in this slice; the
// no-reload APPLY capability is gated on #1214 / #1037 P4.1.
export {
  RenderableViewCard,
  RenderableViewFallback,
  RENDERABLE_VIEW_COMPONENTS,
  ContentChangeProposalCard,
  ArtifactPreviewCard,
  CitationGroupCard,
  ChangeHistoryCard,
} from "../renderable-views/index";
