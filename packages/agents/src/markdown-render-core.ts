// ---------------------------------------------------------------------------
// THE ONE MARKDOWN RENDERER, AND WHY IT LIVES HERE (cinatra#2934, W5c).
//
// The per-run prompt window and /chat draw prose from the SAME assistant, so
// they must draw it the same way — a window that prints `**bold**` as four
// literal characters is showing the reader the model's punctuation instead of
// its answer. The renderer was `packages/chat/src/markdown-render.ts` and could
// not simply be imported: `@cinatra-ai/chat` DEPENDS ON `@cinatra-ai/agents`
// (see its package.json), so an agents -> chat import is a dependency cycle.
// The edge that exists runs the other way, so the renderer moved DOWN to the
// package both sides may reach: this one. `marked` was already a dependency
// here; nothing new was added to make the move.
//
// WHAT MOVED AND WHAT DID NOT. Everything that turns markdown into HTML moved:
// the escaping, the URL allowlist, and every renderer override. What stayed in
// `@cinatra-ai/chat` is what only /chat has — the syntax highlighter, KaTeX,
// mermaid, charts, widgets and the table's copy/CSV chrome — supplied through
// the hooks below. So there is ONE definition of the markup and ONE definition
// of the escaping, and a fix to either reaches both surfaces.
//
// THE SOURCE IS UNTRUSTED. The HTML built here is injected with
// dangerouslySetInnerHTML by both callers, and assistant output is
// prompt-injectable, tool output is remote-controlled, and stored threads
// replay arbitrary past content. Every interpolation escapes text and
// scheme-allowlists URLs; that property is the reason this is shared code and
// not a second copy.
// ---------------------------------------------------------------------------
import { Marked, type Tokens } from "marked";

export const LINK_CLASSES = "text-muted-foreground underline underline-offset-4 hover:text-foreground";

// Markdown rendered here is injected via dangerouslySetInnerHTML, and the source
// is untrusted (assistant output is prompt-injectable, tool output is
// remote-controlled, and stored/shared threads replay arbitrary past content).
// The custom marked renderer below replaces marked's default renderers, which
// would otherwise HTML-escape text and scheme-clean URLs — so every text/URL
// interpolation must re-apply those protections explicitly. escapeHtml mirrors
// marked's own entity escaping for any value written into element text or an
// HTML attribute value.
export function escapeHtml(value: string): string {
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
export function safeHref(href: string): string | null {
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

/**
 * What a surface supplies on top of the shared renderer.
 *
 * Deliberately small: a hook here is a place the two surfaces are ALLOWED to
 * differ, so every hook has to earn itself. The defaults are the plain reading
 * — no chrome, no pagination, text as it stands — which is the run window's.
 */
export type CoreMarkedHooks = {
  /** How a fenced code block is drawn. */
  code: (token: Tokens.Code) => string;
  /**
   * A table cell's raw text as it should appear in the CSV column. /chat
   * resolves its app-link placeholders back to labels here; the default is the
   * text as it stands.
   */
  resolveText?: (text: string) => string;
  /** Chrome drawn at the head of a table frame — /chat's copy + CSV buttons. */
  tableChrome?: (ctx: { tableId: string; csvData: string }) => string;
  /**
   * Rows per page. The default draws EVERY row and no pager, because a pager
   * whose buttons nothing is listening to is a control that lies.
   */
  tablePageSize?: number;
};

/**
 * A fresh Marked instance per render — the table renderer counts ids in a
 * closure, so a shared instance would hand two bubbles the same table id.
 */
export function createCoreMarked(hooks: CoreMarkedHooks) {
  let tableIndex = 0;
  const resolveText = hooks.resolveText ?? ((text: string) => text);

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
      // THE ONE RENDERER THIS SURFACE SUPPLIES. A fenced block is the only
      // place the two surfaces legitimately differ: /chat hydrates it with the
      // syntax highlighter it already loads, the run window draws it plain
      // rather than pull that weight into a panel that shows prose. Everything
      // else below — including every escape — is shared, which is the point.
      code(token: Tokens.Code) {
        return hooks.code(token);
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
        const pageSize = hooks.tablePageSize ?? Number.POSITIVE_INFINITY;
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
          csvHeaderCells.map((c) => `"${resolveText(c).replace(/"/g, '""')}"`).join(","),
          ...csvBodyRows.map((cells) => cells.map((c) => `"${resolveText(c).replace(/"/g, '""')}"`).join(",")),
        ];
        const csvData = csvRows.join("\\n");

        // audit-allow: markdown-content
        return `<div class="my-3 overflow-hidden rounded-lg border border-line bg-card" data-chat-table-frame>${hooks.tableChrome?.({ tableId, csvData }) ?? ""}<div class="overflow-x-auto"><table id="${tableId}" class="min-w-full caption-bottom text-sm"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table></div>${shouldPaginate ? `<div class="flex flex-col gap-2 border-t border-line bg-card px-3 py-2 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between" data-chat-table-pagination data-page="0" data-page-size="${pageSize}" data-row-count="${bodyRows.length}"><span data-chat-table-range-label>1-${Math.min(pageSize, bodyRows.length)} of ${bodyRows.length}</span><div class="flex items-center gap-2"><span data-chat-table-page-label>Page 1 of ${pageCount}</span><div class="flex items-center gap-1"><button type="button" class="chat-table-pagination-action inline-flex h-7 items-center justify-center rounded-md border border-line bg-background px-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50" data-action="previous" disabled>Previous</button><button type="button" class="chat-table-pagination-action inline-flex h-7 items-center justify-center rounded-md border border-line bg-background px-2 text-xs font-medium text-foreground transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50" data-action="next" ${pageCount <= 1 ? "disabled" : ""}>Next</button></div></div></div>` : ""}</div>`;
      },
      // Suppress default table sub-renderers (we handle everything in table()).
      tablerow() { return ""; },
      tablecell() { return ""; },
    },
  });


  return md;
}

/**
 * A row of a simplified pipe table: text, a pipe, more text — and the text
 * before the FIRST pipe is itself pipe-free and non-empty, which is what keeps
 * a proper markdown row (`| a | b |`, whose first character is the pipe) out of
 * this shape. Read off the line's own first pipe rather than matched, so the
 * answer costs one scan of the line and cannot be made to cost more.
 */
function isSimplifiedTableRow(line: string): boolean {
  const firstPipe = line.indexOf("|");
  return firstPipe > 0 && firstPipe < line.length - 1;
}

/** The row's cells, blank ones dropped — the shape both sides below count on. */
function simplifiedTableCells(line: string): string[] {
  return line.split("|").map((cell) => cell.trim()).filter(Boolean);
}

/**
 * A model writes a pipe table without the separator row markdown needs, and
 * this puts the separator in so `marked`'s GFM parser sees a table.
 *
 * IT IS A SCAN, NOT A PATTERN, AND THAT IS THE POINT. This was a regular
 * expression with a repetition nested inside a repetition — one row's `[^\n]+`
 * could swallow the pipe another row's iteration wanted, so a run of
 * table-looking lines could be split between the two in a great many ways, and
 * a line the validation then rejected made the engine try them. On assistant
 * prose that is a slow render; on adversarial text it is the whole render. The
 * scan below reads every line exactly once and decides from the line itself, so
 * the cost is the length of the text and nothing about its shape.
 *
 * The newline arithmetic is the pattern's, kept exactly: the newline BEFORE a
 * converted block is re-emitted (so a block that opens the text gains one), and
 * the newline AFTER its last row is swallowed. A block whose cells do not hold
 * up — a header of one cell, a row shorter than the header — is left exactly as
 * it was written, and the scan resumes after it rather than looking for a
 * smaller table inside it.
 */
function insertPipeTableSeparators(text: string): string {
  const lines = text.split("\n");
  let out = "";
  // Whether the line just emitted still owes its newline separator. It is false
  // at the start of the text, and after a converted block, whose trailing
  // newline the conversion swallowed.
  let owesNewline = false;
  let i = 0;
  while (i < lines.length) {
    const header = lines[i]!;
    let last = i;
    if (isSimplifiedTableRow(header)) {
      while (last + 1 < lines.length && isSimplifiedTableRow(lines[last + 1]!)) last += 1;
    }
    if (last > i) {
      const headerCells = simplifiedTableCells(header);
      const bodyRows = lines.slice(i + 1, last + 1).map(simplifiedTableCells);
      if (headerCells.length >= 2 && bodyRows.every((cells) => cells.length >= 2)) {
        out += `\n| ${headerCells.join(" | ")} |`;
        out += `\n| ${headerCells.map(() => "---").join(" | ")} |`;
        for (const cells of bodyRows) out += `\n| ${cells.join(" | ")} |`;
        owesNewline = false;
        i = last + 1;
        continue;
      }
      if (owesNewline) out += "\n";
      out += lines.slice(i, last + 1).join("\n");
      owesNewline = true;
      i = last + 1;
      continue;
    }
    if (owesNewline) out += "\n";
    out += header;
    owesNewline = true;
    i += 1;
  }
  return out;
}

/**
 * The shape fixes every surface wants before marked parses.
 *
 * These are model-output habits rather than markdown: a pipe table written
 * without its separator row, bullets glued onto the end of a sentence, a list
 * marker stranded on its own line. They are here rather than in either caller
 * because the reason to apply them — the text came from a model — is the same
 * on both.
 */
export function normalizeCoreMarkdown(text: string): string {
  // Convert simplified pipe tables (no separator line) to standard markdown
  // format so that marked's GFM parser can handle them.
  let out = insertPipeTableSeparators(text);

  // Split inline "• " separated content onto separate lines so list parsing handles each item.
  out = out.replace(/([^\n]) • /g, "$1\n• ");
  // Normalize "• " bullet lines to "- " for marked's list parser.
  out = out.replace(/^• /gm, "- ");
  // Fix standalone "•" alone on a line followed by content on the next line (no trailing space).
  out = out.replace(/^•\n(?=[^\n])/gm, "- ");
  // Fix numbered list marker alone on its own line: "1.\nContent" → "1. Content".
  out = out.replace(/^(\d+\.)\n(?=[^\n])/gm, "$1 ");

  return out;
}

/**
 * marked leaves empty paragraphs behind wherever a placeholder was stripped.
 *
 * The attribute run excludes `<` as well as `>`. It reads like a detail and is
 * the difference between a linear scan and a quadratic one: with `<` allowed,
 * an opening `<p` that never finds its `>` keeps scanning through every `<p`
 * after it, and a text of many of them costs the square of its length. No tag
 * this is ever handed can carry a `<` in an attribute — the HTML is marked's
 * own output, and every value written into it is escaped — so nothing that
 * matched before stops matching.
 */
export function stripEmptyParagraphs(html: string): string {
  return html.replace(/<p[^<>]*>\s*<\/p>/g, "");
}
