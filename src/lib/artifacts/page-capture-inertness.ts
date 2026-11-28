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

/** The named references that can spell a construct name or an unsafe scheme.
 * Deliberately tiny: this is a NORMALIZER for the matchers below, not an HTML
 * entity decoder for display. */
const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  colon: ":",
  Tab: "\t",
  NewLine: "\n",
  sol: "/",
  quot: '"',
  apos: "'",
  lpar: "(",
  rpar: ")",
};

/**
 * Decode numeric (`&#114;` / `&#x72;`) and the few named character references a
 * browser resolves before interpreting an attribute name, value or URL scheme.
 * Applied repeatedly (bounded) so a doubly-encoded reference cannot hide a
 * construct behind one pass.
 */
export function decodeCharacterReferences(input: string): string {
  let out = input;
  for (let pass = 0; pass < 3; pass++) {
    const next = out
      .replace(/&#x([0-9a-f]{1,6});?/gi, (m, hex) => {
        const code = Number.parseInt(String(hex), 16);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : m;
      })
      .replace(/&#([0-9]{1,7});?/g, (m, dec) => {
        const code = Number.parseInt(String(dec), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000
          ? String.fromCodePoint(code)
          : m;
      })
      .replace(/&([a-zA-Z]{2,8});/g, (m, name) => NAMED_REFERENCES[String(name)] ?? m);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Strip every executable / live-document construct from a fetched page.
 * Idempotent: sanitizing an already-sanitized document changes nothing.
 */
export function sanitizeCapturedHtml(rawHtml: string): SanitizedCapture {
  // NORMALIZE FIRST. A browser DECODES character references inside attribute
  // names/values before acting on them, so `http-equiv="&#x72;efresh"` is a real
  // refresh and `&#111;nload=` is a real handler — while a raw-text matcher sees
  // neither (a codex convergence finding, reachable from PROPOSED content once
  // L-D composes agent-authored values into the page). Decoding the numeric and
  // the handful of named references that can spell a construct means the
  // sanitizer and the browser read the SAME document. Decoding never introduces
  // markup that was not already meant as markup, and the re-verify pass runs on
  // this normalized text too.
  let html = decodeCharacterReferences(String(rawHtml ?? ""));
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

  // `<meta http-equiv=...>` — the only http-equiv values that matter here are
  // navigation instructions, and a page capture needs NONE of them, so the whole
  // family is dropped rather than pattern-matched on `refresh` alone.
  const metaRefresh = countAndReplace(html, /<meta\b[^>]*\bhttp-equiv\b[^>]*>/gi, "");
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

  // Inline event handlers, in all three attribute-quoting forms. The separator
  // is whitespace OR `/`: HTML lets `<svg/onload=…>` start an attribute after a
  // solidus, so a whitespace-only matcher missed it (a codex finding).
  const handlers = countAndReplace(
    html,
    /[\s/]on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
    " ",
  );
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
  // Same normalization the sanitizer applies, so the check reads the document
  // the BROWSER will read, not the raw bytes.
  const source = decodeCharacterReferences(String(html ?? ""));
  const violations: InertnessViolation[] = [];
  const push = (kind: InertnessViolation["kind"], match: RegExpMatchArray | null) => {
    if (match) violations.push({ kind, sample: match[0].slice(0, 80) });
  };
  push("script", source.match(/<\/?(?:script|noscript)\b/i));
  push("frame", source.match(/<\/?(?:iframe|frame|frameset|object|embed|applet|portal)\b/i));
  push("event-handler", source.match(/[\s/]on[a-z0-9_-]+\s*=/i));
  push("srcdoc", source.match(/\ssrcdoc\s*=/i));
  push("meta-refresh", source.match(/<meta\b[^>]*\bhttp-equiv\b/i));
  push("unsafe-url", source.match(/=\s*["']?\s*(?:javascript|vbscript|data:text\/html)/i));
  return violations;
}

/** True when the document carries no executable / live-document construct. */
export function isCapturedHtmlInert(html: string): boolean {
  return findInertnessViolations(html).length === 0;
}
