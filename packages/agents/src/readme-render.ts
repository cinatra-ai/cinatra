// SPDX-License-Identifier: LicenseRef-Cinatra-Proprietary
//
// Sanitized Markdown render of an extension's README for the marketplace
// detail screen.
//
// Source contract:
//   - Input is the raw `readmeMarkdown` field on the catalog entry / package
//     detail. Extracted from the tarball by the cinatra-app sync worker
//     with a size cap enforced AT EXTRACTION.
//   - Vendor edits in the marketplace UI are NOT the source of truth — the
//     README always tracks the package tarball's `README.md` (this matches
//     the npm contract). Editing happens by re-publishing a new version.
//   - Markdown is UNTRUSTED input. Sanitization happens at render — not at
//     extraction. This module owns that sanitization step.
//
// Approach:
//   - `marked` v18 with the default GFM renderer. Marked v18 escapes raw
//     HTML by default in its output (renderer.html escapes the open tag);
//     a vendor cannot inject `<script>` by writing it in their README.
//   - A constrained renderer for the marketplace surface that strips link
//     `href` attributes to a safe allowlist (http/https/mailto/cinatra:),
//     removes image `src` URLs that aren't http/https (no `javascript:`,
//     no `data:` blobs), and disables raw HTML passthrough.
//   - Result is returned as a string of safe HTML that the caller renders
//     via `dangerouslySetInnerHTML` inside a constrained container.

import { Marked, type Token } from "marked";

/**
 * Allowed URL schemes for hyperlinks inside a README. Anything else is
 * dropped (the link text remains, but the `href` is empty so the browser
 * does not navigate).
 */
const ALLOWED_URL_SCHEMES = new Set([
  "http:",
  "https:",
  "mailto:",
  // Cinatra install deep-link scheme — vendors may legitimately want to
  // surface a "click to install in your Cinatra instance" link inside their
  // README. The cinatra-app deep-link consumer is the legitimate handler.
  "cinatra:",
]);

function isSafeUrl(rawUrl: string): boolean {
  // Strict: require an explicit absolute scheme in the input string itself.
  // Relative paths (`/configuration`, `../wp-admin/foo`) and protocol-relative URLs
  // (`//evil.example/x`) are NOT acceptable in a marketplace README — vendor
  // input must not gain implicit context from the render-time host.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) {
    return false;
  }
  try {
    // Parse without a base URL so the scheme MUST be present in the input.
    const url = new URL(rawUrl);
    return ALLOWED_URL_SCHEMES.has(url.protocol);
  } catch {
    // Unparseable URL — drop the href; the link text remains.
    return false;
  }
}

/**
 * Marked stores token data on the renderer's `parser` member at runtime
 * (renderer functions are bound to a `_RendererThis` shape that carries
 * `parser.parseInline`). The interface here is the narrow slice we need to
 * recursively render link/image child tokens through the SAME constrained
 * renderer (so raw HTML inside link text gets stripped, not re-emitted as
 * the raw token string).
 */
type ParserShape = { parseInline: (tokens: Token[]) => string };
type RendererThis = { parser: ParserShape };

function buildReadmeMarked(): Marked {
  const marked = new Marked({
    gfm: true,
    breaks: false,
    pedantic: false,
  });
  marked.use({
    renderer: {
      // Strip unsafe link hrefs. The link text is rendered RECURSIVELY through
      // the same constrained renderer via `this.parser.parseInline(tokens)` —
      // raw HTML inside link text (e.g. `[<script>](https://x)`) gets stripped
      // by the `html()` override below instead of being re-emitted as the raw
      // token string. Direct token-string concatenation here was an earlier
      // XSS vector.
      link(this: RendererThis, { href, title, tokens }: { href: string; title?: string | null; tokens: Token[] }): string {
        const inner = this.parser.parseInline(tokens ?? []);
        const safeHref = isSafeUrl(href) ? href : "";
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
        const relAttr = /^https?:/i.test(safeHref) ? ' rel="noopener noreferrer nofollow" target="_blank"' : "";
        return safeHref
          ? `<a href="${escapeAttribute(safeHref)}"${titleAttr}${relAttr}>${inner}</a>`
          : `<span>${inner}</span>`;
      },
      // Strip unsafe image srcs.
      image({ href, title, text }: { href: string; title?: string | null; text: string }): string {
        const safeSrc = isSafeUrl(href) && /^https?:/i.test(href) ? href : "";
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
        const altAttr = ` alt="${escapeAttribute(text)}"`;
        return safeSrc
          ? `<img src="${escapeAttribute(safeSrc)}"${altAttr}${titleAttr} loading="lazy" referrerpolicy="no-referrer" />`
          : `<span class="text-muted-foreground">[image]${text ? ` ${escapeAttribute(text)}` : ""}</span>`;
      },
      // Disable raw HTML passthrough completely — vendor cannot inject
      // any markup the renderer doesn't whitelist.
      html(): string {
        return "";
      },
    },
  });
  return marked;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const readmeMarked = buildReadmeMarked();

/**
 * Render an untrusted extension README as safe HTML.
 *
 * `null` or empty input → empty string (the caller hides the surrounding
 * "About" section so an empty README never leaves a broken empty pane).
 */
export function renderReadmeMarkdown(readme: string | null | undefined): string {
  if (!readme || readme.trim().length === 0) {
    return "";
  }
  // `parse` is synchronous in marked v18 (returns string; Promise<string>
  // when `async:true` is set, which we don't).
  return readmeMarked.parse(readme) as string;
}
