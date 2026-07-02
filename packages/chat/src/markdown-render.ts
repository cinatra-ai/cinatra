// Markdown renderer for chat assistant/tool output.
//
// Extracted from chat-page.tsx so the renderer can be unit-tested in isolation
// (chat-page.tsx pulls in app-only `@/` aliases that a package-level test
// harness cannot resolve). The rendered HTML is injected via
// dangerouslySetInnerHTML and the source is UNTRUSTED — assistant output is
// prompt-injectable, tool output is remote-controlled, and stored/shared
// threads replay arbitrary past content — so every interpolation here must
// escape text and scheme-allowlist URLs.
import { Marked, type Tokens } from "marked";
import { getHighlightedSync, type ThemeName } from "./syntax-highlight";
import { preprocessMath, restoreMath } from "./math-render";
import { validateChart, type ChartSpec } from "./chart-schema";
import type { DetectedWidget } from "./widget-runtime";

const APP_ROUTES = "campaigns|content|sources|accounts|contacts|transcript-generators";
const LINK_CLASSES = "text-muted-foreground underline underline-offset-4 hover:text-foreground";

// Markdown rendered here is injected via dangerouslySetInnerHTML, and the source
// is untrusted (assistant output is prompt-injectable, tool output is
// remote-controlled, and stored/shared threads replay arbitrary past content).
// The custom marked renderer below replaces marked's default renderers, which
// would otherwise HTML-escape text and scheme-clean URLs — so every text/URL
// interpolation must re-apply those protections explicitly. escapeHtml mirrors
// marked's own entity escaping for any value written into element text or an
// HTML attribute value.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Allowlist the URL schemes that may appear in a rendered href. Anything not
// matching is treated as unsafe and dropped (the caller renders link text with
// no href). This mirrors marked's default cleanUrl behavior, which the custom
// link renderer below otherwise bypasses. Relative/internal app paths (starting
// with "/", "./", "../", "#", or "?") and protocol-relative-free fragments are
// permitted; absolute URLs must be http(s) or mailto. Leading control chars and
// whitespace are stripped first because browsers ignore them when resolving a
// scheme (e.g. "java\tscript:").
function safeHref(href: string): string | null {
  // Strip ASCII control chars and whitespace anywhere in the URL — browsers
  // ignore them when resolving the scheme (e.g. "java\tscript:" runs as
  // "javascript:"), so they must not defeat the scheme allowlist below.
  // eslint-disable-next-line no-control-regex
  const trimmed = href.replace(/[\u0000-\u0020\u007f]/g, "");
  if (trimmed === "") return null;
  // Protocol-relative URLs resolve to an absolute cross-origin navigation, so
  // they must NOT slip through as "internal". Browsers normalize a BACKSLASH
  // leading pair (and mixed slash/backslash) to "//" too — "/\\evil.com",
  // "\\\\evil", "\\/evil", "/\\/evil" all become protocol-relative — so reject
  // ANY two leading slash-or-backslash chars, before the root-relative check.
  if (/^[\\/]{2}/.test(trimmed)) return null;
  // Relative / internal references — no scheme, cannot execute script.
  // Root-relative ("/path"), fragment ("#x"), query ("?x"), or dot-relative
  // ("./", "../") only.
  if (/^[/#?]/.test(trimmed) || /^\.\.?\//.test(trimmed)) return trimmed;
  // Absolute URLs: only allow http(s) and mailto.
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return null;
}
function createMarkedInstance(theme: ThemeName = "github-light") {
  let tableIndex = 0;
  const appLinks: { html: string; label: string }[] = [];

  function appLinkPlaceholder(href: string, label: string): string {
    const idx = appLinks.length;
    // href/label are derived from untrusted markdown captures; scheme-allowlist
    // the href and escape both before writing into the anchor markup. (#269)
    const safe = safeHref(href);
    const safeLabel = escapeHtml(label);
    const html =
      safe === null
        ? `<span class="${LINK_CLASSES}">${safeLabel}</span>`
        : `<a href="${escapeHtml(safe)}" class="${LINK_CLASSES}">${safeLabel}</a>`;
    appLinks.push({ html, label });
    return `%%APPLINK_${idx}%%`;
  }

  // Resolve applink placeholders to plain text (for CSV data attributes).
  function resolveAppLinksAsText(text: string): string {
    return text.replace(/%%APPLINK_(\d+)%%/g, (_, idx) => appLinks[parseInt(idx)]?.label ?? "");
  }

  const md = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const text = this.parser.parseInline(tokens);
        if (depth <= 2) return `<h2 class="text-lg font-semibold text-foreground mt-5 mb-2">${text}</h2>`;
        return `<h3 class="text-base font-semibold text-foreground mt-4 mb-1">${text}</h3>`;
      },
      paragraph({ tokens }: Tokens.Paragraph) {
        return `<p class="my-2 leading-relaxed text-foreground">${this.parser.parseInline(tokens)}</p>`;
      },
      strong({ tokens }: Tokens.Strong) {
        return `<strong class="font-semibold text-foreground">${this.parser.parseInline(tokens)}</strong>`;
      },
      em({ tokens }: Tokens.Em) {
        return `<em class="italic text-foreground">${this.parser.parseInline(tokens)}</em>`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const inner = this.parser.parse(tokens).replace(/^<p[^>]*>([\s\S]*)<\/p>$/, "$1");
        return `<blockquote class="my-3 border-l-2 border-line pl-4 text-muted-foreground italic">${inner}</blockquote>`;
      },
      del({ tokens }: Tokens.Del) {
        return `<del class="line-through text-muted-foreground">${this.parser.parseInline(tokens)}</del>`;
      },
      codespan({ text }: Tokens.Codespan) {
        // marked stores the RAW codespan text; its default renderer escapes it.
        // This override must re-escape or inline code like `<img src=x
        // onerror=alert(1)>` would inject live DOM. (#269)
        return `<code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs font-mono text-foreground">${escapeHtml(text)}</code>`;
      },
      code({ text, lang }: Tokens.Code) {
        // Escape HTML to prevent XSS — text from LLM is untrusted.
        const escaped = escapeHtml(text);
        const safeLang = lang ? lang.replace(/[^a-zA-Z0-9-]/g, "") : "";

        // Copy button SVG — reused on both sync-hit and placeholder paths.
        // audit-allow: markdown-content
        const copyBtn = `<button type="button" data-action="copy-code" class="chat-code-copy absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity rounded p-1 text-muted-foreground hover:text-foreground hover:bg-surface-muted" title="Copy code"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><rect x="5.5" y="5.5" width="7" height="7" rx="1"/><path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button>`;

        // Sync cache hit — inject highlighted HTML directly.
        const cachedHtml = getHighlightedSync(text, safeLang || "text", theme);
        if (cachedHtml) {
          return `<div class="chat-code-block relative group my-3 rounded-lg overflow-hidden border border-line">${cachedHtml}${copyBtn}</div>`;
        }

        // Cache miss — emit fallback pre+code block and mark for async hydration.
        // URL-encode the raw source as the data attribute value (UTF-safe, no btoa needed).
        const encodedCode = encodeURIComponent(text);
        return `<div class="chat-code-block relative group my-3 rounded-lg overflow-hidden border border-line" data-shiki-code="${encodedCode}" data-shiki-lang="${safeLang}" data-shiki-theme="${theme}"><pre class="overflow-x-auto whitespace-pre bg-surface-muted p-4 text-[0.8rem] leading-relaxed font-mono text-foreground"><code>${escaped}</code></pre>${copyBtn}</div>`;
      },
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        // Scheme-allowlist the href; marked's default link renderer cleans URLs
        // (dropping javascript:/data:/etc.) but this override bypassed it, so an
        // unsafe scheme would otherwise reach the DOM. (#269)
        const safe = safeHref(href);
        if (safe === null) {
          // Unsafe/unknown scheme — render the link text only, no href.
          return `<span class="${LINK_CLASSES}">${text}</span>`;
        }
        // Escape the (allowlisted) href before writing it into the attribute so
        // quotes/control chars cannot break out of the attribute context.
        const safeAttr = escapeHtml(safe);
        if (/^https?:\/\//i.test(safe)) {
          return `<a href="${safeAttr}" target="_blank" rel="noreferrer" class="${LINK_CLASSES}">${text}</a>`;
        }
        // mailto: or internal app link.
        return `<a href="${safeAttr}" class="${LINK_CLASSES}">${text}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        // marked's `image` renderer is NOT overridden by the other custom
        // renderers above, so without this override marked's DEFAULT image
        // renderer runs — and in marked v18 its `cleanUrl` only `encodeURI`s
        // the src, it no longer scheme-allowlists. That lets `![x](javascript:…)`
        // and `![x](data:text/html,…)` reach the DOM as a live `<img src>` sink,
        // bypassing the scheme allowlist the rest of this renderer enforces.
        // Scheme-allowlist the src with the same safeHref used for links, and
        // escape every attribute value. (#269)
        const safe = safeHref(href);
        const safeAlt = escapeHtml(text);
        if (safe === null) {
          // Unsafe/unknown scheme — drop the image, render the alt text only.
          return safeAlt;
        }
        const safeSrc = escapeHtml(safe);
        const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
        return `<img src="${safeSrc}" alt="${safeAlt}"${titleAttr} class="max-w-full rounded" />`;
      },
      // Raw inline/block HTML in untrusted markdown must NOT pass through to the
      // DOM. marked's default html renderer emits it verbatim; escape it so it
      // renders as inert text instead of executable markup. (#269)
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(text);
      },
      hr() {
        return '<hr class="my-4 border-line" />';
      },
      list(token: Tokens.List) {
        const items = token.items.map((item, i) => {
          const content = this.parser.parse(item.tokens);
          // Strip the first <p> wrapper (loose-list items wrap content in <p class="my-2">,
          // whose top margin detaches the number/bullet from its text).
          const inner = content.replace(/^<p[^>]*>([\s\S]*?)<\/p>/, "$1");
          if (token.ordered) {
            const num = (typeof token.start === "number" ? token.start : 1) + i;
            return `<div class="flex gap-2 my-0.5"><span class="text-muted-foreground shrink-0">${num}.</span><span>${inner}</span></div>`;
          }
          return `<div class="flex gap-2 my-0.5"><span class="text-muted-foreground shrink-0">&bull;</span><span>${inner}</span></div>`;
        });
        return items.join("");
      },
      table(token: Tokens.Table) {
        const tableId = `chat-table-${tableIndex++}`;
        const headerCells = token.header.map((cell) => this.parser.parseInline(cell.tokens));
        const bodyRows = token.rows.map((row) => row.map((cell) => this.parser.parseInline(cell.tokens)));

        // audit-allow: markdown-content
        const ths = headerCells
          .map((c) => `<th class="border-b border-line bg-surface px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">${c}</th>`)
          .join("");
        const pageSize = 25;
        const pageCount = Math.ceil(bodyRows.length / pageSize);
        const shouldPaginate = bodyRows.length > pageSize;
        const trs = bodyRows
          .map((cells, rowIndex) => {
            // audit-allow: markdown-content
            const tds = cells
              .map((c) => `<td class="border-b border-line px-4 py-3 text-sm text-foreground">${c.replace(/([^\n]) • /g, "$1<br>• ")}</td>`)
              .join("");
            // audit-allow: markdown-content
            return `<tr data-chat-table-row="${rowIndex}" class="${rowIndex >= pageSize ? "hidden" : ""}">${tds}</tr>`;
          })
          .join("");

        // CSV for download — use raw text from tokens, resolve applinks to plain text.
        const csvHeaderCells = token.header.map((cell) => cell.text);
        const csvBodyRows = token.rows.map((row) => row.map((cell) => cell.text));
        const csvRows = [
          csvHeaderCells.map((c) => `"${resolveAppLinksAsText(c).replace(/"/g, '""')}"`).join(","),
          ...csvBodyRows.map((cells) => cells.map((c) => `"${resolveAppLinksAsText(c).replace(/"/g, '""')}"`).join(",")),
        ];
        const csvData = csvRows.join("\\n");

        // audit-allow: markdown-content
        return `<div class="my-3 overflow-hidden rounded-lg border border-line bg-card" data-chat-table-frame><div class="flex items-center justify-end gap-1 border-b border-line px-2 py-1"><button type="button" data-table-id="${tableId}" data-action="copy" class="chat-table-action inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" title="Copy table"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><rect x="5.5" y="5.5" width="7" height="7" rx="1"/><path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button><button type="button" data-table-id="${tableId}" data-action="download" data-csv="${csvData.replace(/"/g, "&quot;")}" class="chat-table-action inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" title="Download CSV"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div><div class="overflow-x-auto"><table id="${tableId}" class="min-w-full caption-bottom text-sm"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>${shouldPaginate ? `<div class="flex flex-col gap-2 border-t border-line bg-card px-3 py-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between" data-chat-table-pagination data-page="0" data-page-size="${pageSize}" data-row-count="${bodyRows.length}"><span data-chat-table-range-label>1-${Math.min(pageSize, bodyRows.length)} of ${bodyRows.length}</span><div class="flex items-center gap-2"><span data-chat-table-page-label>Page 1 of ${pageCount}</span><div class="flex items-center gap-1"><button type="button" class="chat-table-pagination-action inline-flex h-7 items-center justify-center rounded-md border border-line bg-background px-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50" data-action="previous" disabled>Previous</button><button type="button" class="chat-table-pagination-action inline-flex h-7 items-center justify-center rounded-md border border-line bg-background px-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50" data-action="next" ${pageCount <= 1 ? "disabled" : ""}>Next</button></div></div></div>` : ""}</div>`;
      },
      // Suppress default table sub-renderers (we handle everything in table()).
      tablerow() { return ""; },
      tablecell() { return ""; },
    },
  });

  return { md, appLinks, appLinkPlaceholder };
}

// `detectWidgets` is REQUIRED (no default): every caller must pass the live
// runtime's detector so a missing widget catalog is a compile error here, not
// a silently-dead widget surface.
export function renderMarkdown(
  text: string,
  theme: ThemeName,
  detectWidgets: (content: string) => DetectedWidget[],
) {
  const { md, appLinks, appLinkPlaceholder } = createMarkedInstance(theme);

  // Strip mermaid fenced blocks so marked never sees them — they are rendered
  // separately as MermaidBlock React components beside the markdown HTML.
  // Also strip [chart:{...}] embeds and ```chart``` fenced blocks — rendered
  // separately as ChartEmbed components.
  const stripped = stripChartEmbeds(
    text
      .replace(/```mermaid\n[\s\S]*?```/g, "")
      .replace(/```chart\n[\s\S]*?```/g, ""),
  );

  // Pre-process: strip widget/confirm markers and extract app link placeholders.
  let cleaned = stripped
    .replace(/\[widget:[a-z0-9.-]+:[a-f0-9-]{36}\]/gi, "")
    .replace(/\[confirm-[a-z_-]+:[a-f0-9-]{36}\]/gi, "")
    // Strip bare URL lines only if they match a widget detector (rendered as embed).
    // Also handles lines inside blockquotes ("> /campaigns/...").
    .replace(new RegExp(`^(?:>\\s*)*[#"']*\\/?(?:${APP_ROUTES})\\/[^\\s"']*["']?$`, "gm"), (line) => {
      const trimmed = line.replace(/^[>\s#"']+|["']+$/g, "").trim();
      const hasWidget = detectWidgets(trimmed).length > 0;
      if (hasWidget) return "";
      const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
      return appLinkPlaceholder(path, path);
    })
    // Convert markdown links to app routes into placeholders.
    .replace(new RegExp(`\\[([^\\]]*)\\]\\([#/]*(?:${APP_ROUTES})\\/[^)]+\\)`, "g"), (match, label) => {
      const hrefMatch = match.match(/\(([^)]+)\)/);
      if (!hrefMatch) return match;
      const href = hrefMatch[1].replace(/^#/, "");
      return appLinkPlaceholder(href, label);
    });

  // Pre-process math: replace $$...$$ and $...$ with placeholders before marked
  // parses, so marked does not interfere with $ or \ escaping inside LaTeX.
  const { text: mathProcessed, placeholders: mathPlaceholders } = preprocessMath(cleaned);
  cleaned = mathProcessed;

  // Convert simplified pipe tables (no separator line) to standard markdown format
  // so that marked's GFM parser can handle them.
  cleaned = cleaned.replace(
    /(?:^|\n)([^\n|]+\|[^\n]+)\n((?:[^\n|]+\|[^\n]+\n?){1,})/g,
    (match, headerRow: string, bodyRows: string) => {
      const headerCells = headerRow.split("|").map((c: string) => c.trim()).filter(Boolean);
      if (headerCells.length < 2) return match;
      const bodyRowsArr = bodyRows.trim().split("\n").map((row: string) => row.split("|").map((c: string) => c.trim()).filter(Boolean));
      if (bodyRowsArr.length === 0 || bodyRowsArr.some((r: string[]) => r.length < 2)) return match;
      // Insert a separator line to make it a standard markdown table.
      const sep = "| " + headerCells.map(() => "---").join(" | ") + " |";
      const header = "| " + headerCells.join(" | ") + " |";
      const rows = bodyRowsArr.map((cells: string[]) => "| " + cells.join(" | ") + " |").join("\n");
      return `\n${header}\n${sep}\n${rows}`;
    },
  );

  // Split inline "• " separated content onto separate lines so list parsing handles each item.
  cleaned = cleaned.replace(/([^\n]) • /g, "$1\n• ");
  // Normalize "• " bullet lines to "- " for marked's list parser.
  cleaned = cleaned.replace(/^• /gm, "- ");
  // Fix standalone "•" alone on a line followed by content on the next line (no trailing space).
  cleaned = cleaned.replace(/^•\n(?=[^\n])/gm, "- ");
  // Fix numbered list marker alone on its own line: "1.\nContent" → "1. Content".
  cleaned = cleaned.replace(/^(\d+\.)\n(?=[^\n])/gm, "$1 ");

  let html = md.parse(cleaned, { async: false }) as string;

  // Restore app link placeholders.
  for (let i = 0; i < appLinks.length; i++) {
    html = html.replaceAll(`%%APPLINK_${i}%%`, appLinks[i].html);
  }

  // Restore math placeholders (KaTeX HTML) after marked processing.
  html = restoreMath(html, mathPlaceholders);

  // Remove empty paragraphs.
  html = html.replace(/<p[^>]*>\s*<\/p>/g, "");

  return html;
}

// Maximum payload size (bytes) accepted from a single [chart:...] embed.
// Prevents the UI from freezing on a maliciously large JSON blob from the LLM.
const CHART_PAYLOAD_MAX_BYTES = 20_000;

export type DetectedChart = { spec: ChartSpec | null; raw: string };

/**
 * Balanced-bracket scan for [chart:{...}] embeds.
 *
 * Rationale: a simple regex like /\[chart:(.*?)\]/g would fail whenever the
 * JSON value itself contains a `]` character (e.g. arrays). Instead we walk
 * character-by-character, tracking the depth of `{` / `}` pairs so we know
 * exactly where the JSON object ends and can then expect the closing `]`.
 *
 * Security: untrusted LLM output — validateChart() is called on every result;
 * results are never passed to dangerouslySetInnerHTML.
 */
export function detectCharts(text: string): DetectedChart[] {
  const results: DetectedChart[] = [];

  // Also detect ```chart\n{...}\n``` fenced code blocks emitted by LLMs.
  const codeBlockRegex = /```chart\n([\s\S]*?)\n```/g;
  let codeMatch: RegExpExecArray | null;
  while ((codeMatch = codeBlockRegex.exec(text)) !== null) {
    const raw = codeMatch[0];
    const jsonPayload = codeMatch[1].trim();
    if (jsonPayload.length > CHART_PAYLOAD_MAX_BYTES) {
      results.push({ spec: null, raw });
    } else {
      let parsed: unknown = null;
      try { parsed = JSON.parse(jsonPayload); } catch { /* invalid json */ }
      results.push({ spec: parsed !== null ? validateChart(parsed) : null, raw });
    }
  }

  const PREFIX = "[chart:";
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf(PREFIX, searchFrom);
    if (start === -1) break;

    const jsonStart = start + PREFIX.length;
    if (text[jsonStart] !== "{") {
      searchFrom = start + 1;
      continue;
    }

    // Walk forward tracking brace depth.
    let depth = 0;
    let i = jsonStart;
    let jsonEnd = -1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          jsonEnd = i;
          break;
        }
      }
      i++;
    }

    if (jsonEnd === -1) {
      searchFrom = start + 1;
      continue;
    }

    // Expect ']' immediately after the closing '}'.
    if (text[jsonEnd + 1] !== "]") {
      searchFrom = jsonEnd + 1;
      continue;
    }

    const raw = text.slice(start, jsonEnd + 2); // includes "[chart:" ... "}]"
    const jsonPayload = text.slice(jsonStart, jsonEnd + 1);

    if (jsonPayload.length > CHART_PAYLOAD_MAX_BYTES) {
      results.push({ spec: null, raw });
    } else {
      let parsed: unknown = null;
      try { parsed = JSON.parse(jsonPayload); } catch { /* invalid json */ }
      results.push({ spec: parsed !== null ? validateChart(parsed) : null, raw });
    }

    searchFrom = jsonEnd + 2;
  }

  return results;
}

/**
 * Strips all [chart:{...}] embeds from a string using the same balanced-bracket
 * walker as detectCharts(). Used inside renderMarkdown() so the raw JSON never
 * appears in the HTML output.
 */
function stripChartEmbeds(text: string): string {
  const charts = detectCharts(text);
  let result = text;
  // Replace in reverse order so indices stay valid.
  for (let i = charts.length - 1; i >= 0; i--) {
    result = result.replace(charts[i].raw, "");
  }
  return result;
}
