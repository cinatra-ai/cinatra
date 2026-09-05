// Markdown renderer for chat assistant/tool output.
//
// Extracted from chat-page.tsx so the renderer can be unit-tested in isolation
// (chat-page.tsx pulls in app-only `@/` aliases that a package-level test
// harness cannot resolve). The rendered HTML is injected via
// dangerouslySetInnerHTML and the source is UNTRUSTED — assistant output is
// prompt-injectable, tool output is remote-controlled, and stored/shared
// threads replay arbitrary past content — so every interpolation here must
// escape text and scheme-allowlist URLs.
import { type Tokens } from "marked";
// THE RENDERER ITSELF MOVED (cinatra#2934, W5c). The per-run prompt window has
// to draw the same assistant prose /chat draws, and `@cinatra-ai/chat` depends
// on `@cinatra-ai/agents` — so the shared half lives one package DOWN, where
// both surfaces may reach it, and /chat supplies the parts only /chat has.
import {
  LINK_CLASSES,
  createCoreMarked,
  escapeHtml,
  normalizeCoreMarkdown,
  safeHref,
  stripEmptyParagraphs,
} from "@cinatra-ai/agents/markdown-render-core";
import { getHighlightedSync, type ThemeName } from "./syntax-highlight";
import { preprocessMath, restoreMath } from "./math-render";
// The chart PAYLOAD schema + validator are host-owned and live in the shared
// protocol contract (epic #1620 AC2); the `chart` renderable-view COMPONENT is
// extension-provided (@cinatra-ai/chart-artifact via the generated cinatra.views
// map). This detector stays host-side and never imports the extension.
import { validateChart, type ChartSpec } from "@cinatra-ai/agent-ui-protocol/renderable-views/chart";
import type { DetectedWidget } from "./widget-runtime";

const APP_ROUTES = "campaigns|content|sources|accounts|contacts|transcript-generators";

function createMarkedInstance(theme: ThemeName = "github-light") {
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

  const md = createCoreMarked({
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
    // The CSV column wants the app link's label, not its placeholder token.
    resolveText: resolveAppLinksAsText,
    // /chat pages a long table and listens for these buttons; the run window
    // draws neither, which is why both are surface-supplied and not built in.
    tablePageSize: 25,
    // audit-allow: markdown-content
    tableChrome: ({ tableId, csvData }) => `<div class="flex items-center justify-end gap-1 border-b border-line px-2 py-1"><button type="button" data-table-id="${tableId}" data-action="copy" class="chat-table-action inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" title="Copy table"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><rect x="5.5" y="5.5" width="7" height="7" rx="1"/><path d="M3.5 10.5V4a1 1 0 0 1 1-1h6.5"/></svg></button><button type="button" data-table-id="${tableId}" data-action="download" data-csv="${csvData.replace(/"/g, "&quot;")}" class="chat-table-action inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground" title="Download CSV"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" class="h-3.5 w-3.5"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 12h10" stroke-linecap="round" stroke-linejoin="round"/></svg></button></div>`,
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

  // The model-output shape fixes are the same on every surface, so they are
  // stated once beside the renderer.
  cleaned = normalizeCoreMarkdown(cleaned);

  let html = md.parse(cleaned, { async: false }) as string;

  // Restore app link placeholders.
  for (let i = 0; i < appLinks.length; i++) {
    html = html.replaceAll(`%%APPLINK_${i}%%`, appLinks[i].html);
  }

  // Restore math placeholders (KaTeX HTML) after marked processing.
  html = restoreMath(html, mathPlaceholders);

  // Remove empty paragraphs.
  html = stripEmptyParagraphs(html);

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

// ---------------------------------------------------------------------------
// Mermaid block detection (moved unchanged from chat-page.tsx, cinatra#918 —
// beside detectCharts: both scan assistant content for renderable embeds and
// both are only needed behind the lazy message-view boundary)
// ---------------------------------------------------------------------------

export type MermaidSource = { source: string };

export function detectMermaidBlocks(text: string): MermaidSource[] {
  const blocks: MermaidSource[] = [];
  const re = /```mermaid\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ source: m[1].trim() });
  }
  return blocks;
}
