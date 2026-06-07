"use client";

import type { Highlighter } from "shiki";

export type ThemeName = "github-dark" | "github-light";

const LANGS = [
  "typescript", "javascript", "tsx", "jsx", "json", "bash", "sh",
  "python", "sql", "yaml", "markdown", "html", "css", "diff",
] as const;

const cache = new Map<string, string>();
let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((m) =>
      m.createHighlighter({
        themes: ["github-dark", "github-light"],
        langs: [...LANGS],
      }),
    );
  }
  return highlighterPromise;
}

function cacheKey(code: string, lang: string, theme: ThemeName): string {
  return `${theme}::${lang}::${code}`;
}

/** Synchronous lookup — returns cached HTML or null. */
export function getHighlightedSync(code: string, lang: string, theme: ThemeName): string | null {
  return cache.get(cacheKey(code, lang, theme)) ?? null;
}

/** Async — loads highlighter if needed, caches and returns HTML. Falls back to null on error. */
export async function highlightCodeAsync(
  code: string,
  lang: string,
  theme: ThemeName,
): Promise<string | null> {
  const key = cacheKey(code, lang, theme);
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const hl = await getHighlighter();
    const safeLang = (LANGS as readonly string[]).includes(lang) ? lang : "text";
    const html = hl.codeToHtml(code, { lang: safeLang, theme });
    cache.set(key, html);
    return html;
  } catch {
    return null;
  }
}
