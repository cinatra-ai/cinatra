/**
 * PURE inertness sanitizer for a fetched preview page (cinatra#2044 S6, L-B).
 *
 * #2044's realm rule: "no scripts, event handlers, or live remote documents ever
 * enter cinatra's realm". The captured page is a REMOTE site's markup, so it is
 * treated as hostile input at two boundaries:
 *
 *   1. Before it is handed to the isolated renderer subprocess (defence in depth
 *      — that browser already runs with JavaScript DISABLED and a same-origin-only
 *      subresource policy, but a sanitized document means an executable construct
 *      cannot even be present if a future renderer relaxes either).
 *   2. Before the sanitized HTML is STORED, so nothing in cinatra's own store can
 *      ever be replayed into a live document.
 *
 * WHAT IS REMOVED (the closed executable/live-document surface):
 *   - `<script>` / `<noscript>` element content, and `<template>`-free inline JS.
 *   - Nested browsing contexts and plugin hosts: `iframe`, `frame`, `frameset`,
 *     `object`, `embed`, `applet`, `portal`.
 *   - Every `on*` inline event-handler attribute.
 *   - `javascript:` / `vbscript:` / `data:text/html` URL values on any attribute.
 *   - `srcdoc` (an inline nested document) and `<base>` (retargets every
 *     relative URL after the fact).
 *   - `<meta http-equiv="refresh">` (a navigation instruction).
 *   - `<link>` whose rel is an import/prefetch/preload of a script-ish kind.
 *
 * WHAT IS KEPT: the visual document — text, structure, `class`/`style`,
 * stylesheets and images. Those are what makes the capture a faithful render;
 * the renderer confines them to the site's own origin.
 *
 * The output is a STATIC document. `assertCapturedHtmlInert` re-checks the
 * result and is used as the pipeline's own contract test — a sanitizer that ever
 * lets a construct through fails the check rather than storing the page.
 *
 * PURE (no DOM, no I/O): the host has no server-side DOM parser in its runtime
 * dependency set (jsdom is dev-only), so this is a conservative, over-removing
 * scanner. Over-removal degrades fidelity; under-removal would be a realm
 * breach — so every ambiguous construct is removed.
 */

/** Elements whose entire subtree is dropped (content included). */
const DROPPED_WITH_CONTENT = [
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
] as const;

/** Void/standalone elements dropped as a single tag. */
const DROPPED_TAGS = ["base"] as const;

export interface SanitizedCapture {
  /** The inert HTML. */
  readonly html: string;
  /** What was removed — recorded on the capture record as provenance so a
   * reviewer can be told the page was sanitized, never silently altered. */
  readonly removed: {
    readonly scripts: number;
    readonly frames: number;
    readonly eventHandlers: number;
    readonly navigations: number;
    readonly unsafeUrls: number;
  };
}

/** An executable/live-document construct that survived sanitization. */
export interface InertnessViolation {
  readonly kind: "script" | "frame" | "event-handler" | "unsafe-url" | "srcdoc" | "meta-refresh";
  readonly sample: string;
}

function countAndReplace(
  html: string,
  pattern: RegExp,
  replacement: string,
): { html: string; count: number } {
  let count = 0;
  const out = html.replace(pattern, () => {
    count += 1;
    return replacement;
  });
  return { html: out, count };
}

/**
 * Strip every executable / live-document construct from a fetched page.
 * Idempotent: sanitizing an already-sanitized document changes nothing.
 */
export function sanitizeCapturedHtml(rawHtml: string): SanitizedCapture {
  let html = String(rawHtml ?? "");
  let scripts = 0;
  let frames = 0;
  let eventHandlers = 0;
  let navigations = 0;
  let unsafeUrls = 0;

  for (const tag of DROPPED_WITH_CONTENT) {
    // Paired form (content dropped). `[\s\S]` so a multi-line body is matched.
    const paired = countAndReplace(
      html,
      new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, "gi"),
      "",
    );
    html = paired.html;
    // Unpaired/self-closed leftovers (a truncated or void-styled occurrence).
    const single = countAndReplace(html, new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi"), "");
    html = single.html;
    const removed = paired.count + single.count;
    if (tag === "script" || tag === "noscript") scripts += removed;
    else frames += removed;
  }

  for (const tag of DROPPED_TAGS) {
    const dropped = countAndReplace(html, new RegExp(`<${tag}\\b[^>]*>`, "gi"), "");
    html = dropped.html;
    navigations += dropped.count;
  }

  // `<meta http-equiv="refresh" ...>` — a navigation instruction.
  const metaRefresh = countAndReplace(
    html,
    /<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\b[^>]*>/gi,
    "",
  );
  html = metaRefresh.html;
  navigations += metaRefresh.count;

  // Script-ish <link> relations (module preload / prefetch / import).
  const linkImports = countAndReplace(
    html,
    /<link\b[^>]*\brel\s*=\s*["']?\s*(?:import|modulepreload|preload|prefetch|prerender)\b[^>]*>/gi,
    "",
  );
  html = linkImports.html;
  navigations += linkImports.count;

  // Inline event handlers, in all three attribute-quoting forms.
  const handlers = countAndReplace(html, /\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = handlers.html;
  eventHandlers += handlers.count;

  // `srcdoc` — an inline nested document.
  const srcdoc = countAndReplace(html, /\ssrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  html = srcdoc.html;
  frames += srcdoc.count;

  // Executable / document-bearing URL schemes on ANY attribute. Neutralized to
  // `about:blank` rather than dropped so the surrounding markup stays valid.
  const unsafe = countAndReplace(
    html,
    /=\s*(?:"\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*'|(?:javascript|vbscript|data:text\/html)[^\s>]*)/gi,
    '="about:blank"',
  );
  html = unsafe.html;
  unsafeUrls += unsafe.count;

  return {
    html,
    removed: { scripts, frames, eventHandlers, navigations, unsafeUrls },
  };
}

/**
 * Re-scan a document and report every executable / live-document construct still
 * present. The pipeline calls this on the SANITIZED output and refuses to store a
 * capture that fails, so the inertness contract is enforced by the writer rather
 * than assumed from the sanitizer.
 */
export function findInertnessViolations(html: string): InertnessViolation[] {
  const source = String(html ?? "");
  const violations: InertnessViolation[] = [];
  const push = (kind: InertnessViolation["kind"], match: RegExpMatchArray | null) => {
    if (match) violations.push({ kind, sample: match[0].slice(0, 80) });
  };
  push("script", source.match(/<\/?(?:script|noscript)\b/i));
  push("frame", source.match(/<\/?(?:iframe|frame|frameset|object|embed|applet|portal)\b/i));
  push("event-handler", source.match(/\son[a-z0-9_-]+\s*=/i));
  push("srcdoc", source.match(/\ssrcdoc\s*=/i));
  push("meta-refresh", source.match(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh\b/i));
  push("unsafe-url", source.match(/=\s*["']?\s*(?:javascript|vbscript|data:text\/html)/i));
  return violations;
}

/** True when the document carries no executable / live-document construct. */
export function isCapturedHtmlInert(html: string): boolean {
  return findInertnessViolations(html).length === 0;
}
