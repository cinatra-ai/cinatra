# `@cinatra-ai/chat/renderer` — reusable conversation renderer

The `/chat` transcript **content renderer**, extracted into a reusable,
embeddable module (#1219, part of the unified-assistant-stream epic #1216) so
every conversational surface renders through **one shared code path**. This
subpath re-exports the exact renderer modules `/chat` renders with; the
Cinatra-served embedded conversation-view that the CMS widgets mount (the S5
iframe target, #1221) mounts this **same** code. Rendering identically is then
definitional, not a property each surface re-implements.

Import it from the package subpath:

```ts
import {
  renderMarkdown,
  detectCharts,
  detectMermaidBlocks,
  ChartEmbed,
  ChartError,
  MermaidBlock,
  validateChart,
  highlightCodeAsync,
  getHighlightedSync,
  type ThemeName,
  type ChartSpec,
  type DetectedChart,
  type MermaidSource,
  type DetectedWidget,
} from "@cinatra-ai/chat/renderer";
```

The barrel is a **pure re-export** boundary — every symbol is the same module
instance the renderer has always used (locked by `renderer-parity.test.ts`:
`barrel.renderMarkdown === markdown-render.renderMarkdown`, byte-identical render
of a fixture corpus). So the embedded view and `/chat` produce identical output
by construction — **zero visual regression**. `/chat` keeps importing those
renderer modules directly rather than through this barrel: the barrel is a pure
alias for code `/chat` already pulls, and routing `/chat`'s internals through a
new module would grow the locked `/chat` route-graph dev-perf budget for no
runtime benefit. The barrel is the **embed entry** (S5) + the stable public API.

## What this module renders

The content layer of a conversation message body:

- **Markdown → HTML** (`renderMarkdown`) — `marked` GFM: paragraphs, headings,
  nested lists, GFM tables (with copy/CSV/pagination affordances), inline &
  fenced code, links, images, blockquotes, strikethrough, horizontal rules.
- **Syntax highlighting** — `shiki`, theme-aware, sync-cache + async hydrate.
- **Math** — `katex` (`$…$` inline, `$$…$$` display).
- **Diagrams** — `mermaid` (`MermaidBlock`).
- **Charts** — `recharts` (`ChartEmbed`) from a validated `[chart:{…}]` /
  ` ```chart ` payload (`detectCharts` + `validateChart`).
- **Inline widget embeds** — detected via a host-supplied widget detector.

All of it is **XSS-hardened** inside `markdown-render`: the custom `marked`
renderer replaces marked's default text-escaping / URL-cleaning renderers, so
every text/attribute interpolation re-applies `escapeHtml`, and every href/src
passes a `safeHref` scheme allowlist (relative/internal paths, `http(s)`,
`mailto` only — `javascript:`, `data:`, protocol-relative and control-char
masked schemes are dropped). The XSS suite (`markdown-xss.test.ts`) exercises
the public entry and moves with the renderer.

## Public API

| Export | Kind | Purpose |
| --- | --- | --- |
| `renderMarkdown(text, theme, detectWidgets)` | fn → HTML string | Render a message body to sanitized HTML for `dangerouslySetInnerHTML`. `theme: ThemeName`; `detectWidgets` is **required** (host supplies its widget catalog's detector). |
| `detectCharts(text)` | fn → `DetectedChart[]` | Balanced-bracket scan for `[chart:{…}]` / fenced `chart` embeds; each result carries a validated `spec` (or `null`). |
| `detectMermaidBlocks(text)` | fn → `MermaidSource[]` | Extract ` ```mermaid ` fenced sources. |
| `validateChart(raw)` | fn → `ChartSpec \| null` | Zod validation/normalization of an untrusted chart payload. |
| `ChartEmbed({ spec })` | React FC | Render a validated `ChartSpec` via `recharts`. |
| `ChartError({ reason })` | React FC | Fallback card for a malformed chart. |
| `MermaidBlock({ source, id })` | React FC | Render a mermaid source as SVG; lazy-loads `mermaid`. |
| `highlightCodeAsync(code, lang, theme)` | async fn | Load `shiki` if needed, highlight, cache. |
| `getHighlightedSync(code, lang, theme)` | fn | Synchronous cache lookup (used on the render fast-path). |

`renderMarkdown` strips mermaid and chart embeds from the HTML it returns — the
host renders `MermaidBlock` / `ChartEmbed` **beside** the HTML using
`detectMermaidBlocks` / `detectCharts`.

## Theming / token strategy

The renderer is **token-driven**, never hard-styled. It emits `@cinatra-ai/design`
design-token utility classes — `text-foreground`, `bg-surface`,
`bg-surface-muted`, `border-line`, `text-muted-foreground`, … — so it inherits
the host's active palette (light/dark) with no per-surface CSS.

- **Code theme** — `ThemeName` (`"github-light" | "github-dark"`) is passed to
  `renderMarkdown` and drives `shiki`. The host maps its resolved theme to a
  `ThemeName`.
- **Diagram theme** — `MermaidBlock` reads `next-themes` (`useTheme`) and
  re-renders on theme change; the host must provide a `next-themes` provider.
- **Chart theme** — `ChartEmbed` reads CSS custom properties (`--chart-1…5`,
  `--border`, `--muted-foreground`, `--surface`) with sensible hardcoded
  fallbacks, so charts theme from the same token layer.

**Host CSS isolation.** For the embedded surface, isolation is structural: the
conversation-view is a **Cinatra-served iframe** (#1221) carrying `/chat`'s own
token stylesheet, so host admin CSS cannot leak in and the renderer's classes
resolve against the Cinatra token layer — not the CMS admin theme. The token
contract the embed host must satisfy: mount the view where its own
`@cinatra-ai/design` tokens + a `next-themes` provider are in scope (the iframe
document already is).

## Bundle budget (lazy-load)

The heavy renderer dependencies stay **off the initial `/chat` shell** and out
of any host admin page:

- **Message-view boundary (primary).** `ChatMessagesView` is mounted via
  `next/dynamic` (`ssr: false`). `marked`, `katex`, `recharts`, the `mermaid`
  wrapper and the `shiki` wrapper all sit behind it and load in their own client
  chunk only when a conversation actually renders — the empty state + composer
  stay eager.
- **Dependency-level lazy.** `shiki` and `mermaid` are additionally
  `import()`-lazy **inside** their wrappers, so they don't even ride the
  message-view chunk until first highlight / first diagram.
- **Host admin page.** Because the embedded view is a separate iframe document
  (#1221), the renderer bundle never loads inside the WordPress/Drupal admin
  page at all — only inside the Cinatra-served iframe.

**Deferred (deliberate).** `katex` and `recharts` are still statically imported
by their modules. Making them dependency-level lazy is deferred because:
`katex.renderToString` runs **synchronously** inside `renderMarkdown` (a lazy
`katex` would force `renderMarkdown` async and cascade into the synchronous
`dangerouslySetInnerHTML` path); and a lazy `recharts` adds a Suspense fallback
flash on first chart. Both would risk the **zero-visual-regression / pixel-parity**
acceptance of this extraction, and both deps already stay off the initial shell
via the message-view boundary above. If pursued later, the only low-risk path is
preloading before first render and proving no fallback / pixel change.

## Scope & the S1 follow-up

This module is the **content renderer** half. It is already decoupled from the
bespoke `chat-stream-events` vocabulary — `renderMarkdown(text, theme,
detectWidgets)` knows nothing about the wire.

The **AG-UI event-to-UI reducer + interactive layer** (tool-call chips, inline
agent-run cards, HITL interrupt forms, citations, thinking groups,
streaming/partial states incl. incomplete-embed trimming, `RUN_ERROR`) is the
piece coupled to `chat-stream-events` today. It moves into this module in a
**follow-up gated on S1 (#1217)**, which defines the versioned AG-UI event
schema the reducer consumes. Extracting it now would bind this module to a
schema that does not exist yet; the content-renderer extraction lands
independently so S3 is not blocked on S1.
