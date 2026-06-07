// KaTeX is imported statically because it's small (~60KB min+gzip including the
// core renderer, without the full font set which is served via CSS). If this
// turns into a perf issue we can switch to dynamic import later.
import katex from "katex";

type MathMap = Map<string, string>;

const DISPLAY_RE = /\$\$([\s\S]+?)\$\$/g;
// Conservative inline pattern: requires a boundary char before $, non-space
// inner content containing at least one LaTeX-ish char, and a boundary char after.
const INLINE_RE = /(^|[\s(\[{,>])\$(?=\S)([^\n$]{1,500}?[\\_^{}][^\n$]{0,500}?)(?<=\S)\$(?=$|[\s)\].,!?:;<])/g;

function renderMath(src: string, displayMode: boolean): string {
  try {
    return katex.renderToString(src, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "html",
    });
  } catch {
    // Last-resort fallback: escape and return original source
    const escaped = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return displayMode
      ? `<pre class="my-3 rounded-lg border border-line bg-surface-muted p-3 text-xs font-mono text-foreground">${escaped}</pre>`
      : `<code class="rounded bg-surface-muted px-1.5 py-0.5 text-xs font-mono text-foreground">${escaped}</code>`;
  }
}

/**
 * Preprocess text by replacing math fragments with placeholders and returning
 * a restoration map. Intended to run BEFORE marked parses the text.
 */
export function preprocessMath(text: string): { text: string; placeholders: MathMap } {
  const placeholders: MathMap = new Map();
  let i = 0;

  // Display math first (greedier marker), so $$ does not interfere with $ inline.
  let result = text.replace(DISPLAY_RE, (_m, src) => {
    const key = `%%MATH_BLOCK_${i++}%%`;
    placeholders.set(key, `<div class="my-3 overflow-x-auto">${renderMath(src.trim(), true)}</div>`);
    return key;
  });

  result = result.replace(INLINE_RE, (_m, pre: string, src: string) => {
    const key = `%%MATH_INLINE_${i++}%%`;
    placeholders.set(key, renderMath(src.trim(), false));
    return `${pre}${key}`;
  });

  return { text: result, placeholders };
}

export function restoreMath(html: string, placeholders: MathMap): string {
  let out = html;
  for (const [key, value] of placeholders) {
    out = out.replaceAll(key, value);
  }
  return out;
}
