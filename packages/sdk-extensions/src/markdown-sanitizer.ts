// The MARKDOWN SANITIZER, as an SDK LEAF ENTRY (enabler 0.5 of
// `PLAN: Agents Lifecycle (C)`, cinatra#3027 / epic #3023).
//
// THE ENABLER, IN THE PLAN'S OWN WORDS: "The markdown sanitizer reachable from
// an extension, as an SDK leaf entry, with one implementation shared with the
// existing readme surface" — because "an extension may depend only on the SDK
// leaf, and the sanitizer lives in a host extension".
//
// WHAT MOVED, AND WHAT DID NOT. The whole implementation moved here VERBATIM
// from the host-adjacent `@cinatra-ai/agents/readme-render`; that module now
// delegates to this one and keeps its own name and its own defaults, so the
// marketplace README surface renders byte-identically and there is exactly ONE
// sanitization boundary in the tree. A second copy would be the failure mode
// this enabler exists to prevent: an extension display and the README surface
// disagreeing about what markdown is safe.
//
// UNTRUSTED INPUT, ALWAYS. Every caller of this module is handing it markdown
// somebody else wrote — a vendor's README, an agent's draft, a person's edit.
// The boundary is therefore at RENDER, never at storage, and it is closed:
//   - `marked` v18 with its default GFM renderer, which escapes raw HTML in its
//     own output, plus an explicit `html()` override that emits NOTHING, so raw
//     markup never survives even if a future marked default relaxes;
//   - link `href` and image `src` restricted to an absolute-scheme allowlist —
//     a relative or protocol-relative URL is refused rather than resolved
//     against whatever host happens to render it;
//   - link/heading child tokens re-rendered RECURSIVELY through this same
//     constrained renderer, never concatenated as raw token strings (that was a
//     real XSS vector before the recursion was added).
//
// LEAF DISCIPLINE. `marked` is this module's only import. It reaches no host
// module, no React, no DOM and no store, so an extension bundle pulling
// `@cinatra-ai/sdk-extensions/markdown-sanitizer` pulls the sanitizer and the
// markdown parser and nothing else.

import { Marked, type Token } from "marked";

/**
 * Allowed URL schemes for hyperlinks inside sanitized markdown. Anything else
 * is dropped (the link text remains, but no `href` is emitted, so the browser
 * does not navigate).
 *
 * `cinatra:` is the install deep-link scheme: an author may legitimately want a
 * "open this in your Cinatra instance" link, and the deep-link consumer is the
 * legitimate handler.
 */
export const ALLOWED_MARKDOWN_URL_SCHEMES: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
  "cinatra:",
]);

/**
 * Is this raw URL string safe to emit as an `href`?
 *
 * STRICT: an explicit absolute scheme must be present IN THE INPUT STRING.
 * Relative paths (`/configuration`, `../wp-admin/foo`) and protocol-relative
 * URLs (`//evil.example/x`) are refused — untrusted markdown must not gain
 * implicit context from the render-time host.
 */
export function isSafeMarkdownUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string") return false;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) return false;
  try {
    // Parsed WITHOUT a base URL, so the scheme must come from the input.
    const url = new URL(rawUrl);
    return ALLOWED_MARKDOWN_URL_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Marked binds renderer functions to a `_RendererThis` shape carrying
 * `parser.parseInline`. This is the narrow slice needed to re-render child
 * tokens through the SAME constrained renderer.
 */
type ParserShape = { parseInline: (tokens: Token[]) => string };
type RendererThis = { parser: ParserShape };

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildSanitizingMarked(options: { demoteHeadings: boolean }): Marked {
  const marked = new Marked({ gfm: true, breaks: false, pedantic: false });
  marked.use({
    renderer: {
      // Demote headings one level (h1→h2 … h5→h6; h6 stays h6) when the surface
      // asks for it — a surface whose page shell already owns the `<h1>` must
      // not receive a second top-level heading. Heading text is re-rendered
      // RECURSIVELY through this same constrained renderer, so demotion never
      // relaxes the boundary.
      ...(options.demoteHeadings
        ? {
            heading(
              this: RendererThis,
              { tokens, depth }: { tokens: Token[]; depth: number },
            ): string {
              const level = Math.min(depth + 1, 6);
              const inner = this.parser.parseInline(tokens ?? []);
              return `<h${level}>${inner}</h${level}>\n`;
            },
          }
        : {}),
      link(
        this: RendererThis,
        { href, title, tokens }: { href: string; title?: string | null; tokens: Token[] },
      ): string {
        const inner = this.parser.parseInline(tokens ?? []);
        const safeHref = isSafeMarkdownUrl(href) ? href : "";
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
        const relAttr = /^https?:/i.test(safeHref)
          ? ' rel="noopener noreferrer nofollow" target="_blank"'
          : "";
        return safeHref
          ? `<a href="${escapeAttribute(safeHref)}"${titleAttr}${relAttr}>${inner}</a>`
          : `<span>${inner}</span>`;
      },
      image({ href, title, text }: { href: string; title?: string | null; text: string }): string {
        const safeSrc = isSafeMarkdownUrl(href) && /^https?:/i.test(href) ? href : "";
        const titleAttr = title ? ` title="${escapeAttribute(title)}"` : "";
        const altAttr = ` alt="${escapeAttribute(text)}"`;
        return safeSrc
          ? `<img src="${escapeAttribute(safeSrc)}"${altAttr}${titleAttr} loading="lazy" referrerpolicy="no-referrer" />`
          : `<span class="text-muted-foreground">[image]${text ? ` ${escapeAttribute(text)}` : ""}</span>`;
      },
      // Raw HTML passthrough is disabled COMPLETELY — an author cannot inject
      // any markup this renderer does not itself emit.
      html(): string {
        return "";
      },
    },
  });
  return marked;
}

const sanitizingMarked = buildSanitizingMarked({ demoteHeadings: false });
const demotingSanitizingMarked = buildSanitizingMarked({ demoteHeadings: true });

export interface SanitizeMarkdownOptions {
  /**
   * Demote every heading one level (`h1→h2 … h5→h6`; `h6` stays `h6`) for a
   * surface whose shell already renders the only `<h1>`.
   *
   * Demotion remaps the heading TAG level only; the sanitization boundary
   * (raw-HTML stripping, the URL-scheme allowlist) is identical on both paths.
   */
  demoteHeadings?: boolean;
}

/**
 * Render untrusted markdown as safe HTML.
 *
 * `null`, `undefined` or blank input renders the empty string, so a caller can
 * hide its surrounding section rather than paint an empty pane.
 *
 * THE RESULT IS HTML, and the caller is expected to inject it (React's
 * `dangerouslySetInnerHTML` or the equivalent) inside a constrained container.
 * That is what makes this module the boundary: nothing downstream re-sanitizes.
 */
export function renderSanitizedMarkdown(
  markdown: string | null | undefined,
  options?: SanitizeMarkdownOptions,
): string {
  if (!markdown || markdown.trim().length === 0) return "";
  const marked = options?.demoteHeadings ? demotingSanitizingMarked : sanitizingMarked;
  // `parse` is synchronous in marked v18 (it returns a Promise only under
  // `async: true`, which this module never sets).
  return marked.parse(markdown) as string;
}
