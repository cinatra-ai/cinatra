// Sanitized Markdown render of an extension's README for the marketplace
// detail screen.
//
// ONE IMPLEMENTATION, IN THE SDK LEAF (enabler 0.5 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027). The sanitizer itself now lives
// at `@cinatra-ai/sdk-extensions/markdown-sanitizer`, because "an extension may
// depend only on the SDK leaf, and the sanitizer lives in a host extension".
// This module keeps its name, its README-specific contract and its callers, and
// delegates the whole sanitization boundary to that one leaf — so the
// marketplace README surface and any extension-owned markdown display cannot
// drift apart about what markdown is safe.
//
// Source contract (unchanged):
//   - Input is the raw `readmeMarkdown` field on the catalog entry / package
//     detail. Extracted from the tarball by the cinatra-app sync worker
//     with a size cap enforced AT EXTRACTION.
//   - Vendor edits in the marketplace UI are NOT the source of truth — the
//     README always tracks the package tarball's `README.md` (this matches
//     the npm contract). Editing happens by re-publishing a new version.
//   - Markdown is UNTRUSTED input. Sanitization happens at render — not at
//     extraction — and the leaf owns that step.

import {
  renderSanitizedMarkdown,
  type SanitizeMarkdownOptions,
} from "@cinatra-ai/sdk-extensions/markdown-sanitizer";

export interface RenderReadmeMarkdownOptions extends SanitizeMarkdownOptions {
  /**
   * Demote every heading one level (`h1→h2 … h5→h6`; `h6` stays `h6`).
   *
   * The marketplace detail surfaces set this: the page hero already renders
   * the only `<h1>` (the extension name), so a README's own `# Title` must
   * render one level down — matching the public marketplace renderer. Surfaces
   * that render markdown standalone leave it off and keep the author's levels.
   */
  demoteHeadings?: boolean;
}

/**
 * Render an untrusted extension README as safe HTML.
 *
 * `null` or empty input → empty string (the caller hides the surrounding
 * section so an empty README never leaves a broken empty pane).
 */
export function renderReadmeMarkdown(
  readme: string | null | undefined,
  options?: RenderReadmeMarkdownOptions,
): string {
  return renderSanitizedMarkdown(readme, options);
}
