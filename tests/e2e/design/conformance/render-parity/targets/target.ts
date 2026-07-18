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

/**
 * The ASYNC live-run analogue of {@link RenderTarget} (the seam the static slice
 * reserved for the live-run targets). A live target drives a REAL running
 * surface — a browser navigating `/chat` (S2-enabled, live today), and — after
 * S5 (#1221) — the generic embedded conversation-view and the WordPress/Drupal
 * iframes — so rendering one fixture is asynchronous (seed a thread, navigate,
 * wait for the surface to settle, scrape the rendered content). The static
 * reference target stays synchronous and browser-free; the two seams coexist so
 * the deterministic static gate never pays the live boot cost, and the live
 * compare reuses the SAME corpus + goldens rather than a second source of truth.
 *
 * The live `/chat` target implements this in the agents-run live suite
 * (tests/e2e/agents-run/chat-render-parity-target.ts) — the only live target
 * S2 unblocks. The embedded-view and CMS-iframe targets implement it after S5;
 * the #1214 no-direct-egress assertion joins THEIR embedded E2E (not `/chat`).
 * The returned shape is identical to the sync result so the compare logic is
 * seam-agnostic: a live target fills `html` (the surface's rendered content)
 * and leaves `charts`/`mermaid` empty — those render as separate components on
 * the live surface (outside the content block) and stay the static detection
 * golden's job until the S4 interactive-layer render-compare lands.
 */
export type AsyncRenderTarget = {
  /** Stable id, e.g. `"chat-live"`, `"embedded-view"`, `"wordpress-iframe"`. */
  readonly id: string;
  /** Human label for reports. */
  readonly label: string;
  /** Render one content markdown source at a theme by driving the real surface. */
  renderContent(source: string, theme: RenderTheme): Promise<ContentRenderResult>;
};
