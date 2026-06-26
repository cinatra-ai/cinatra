// Pure helpers for the agent-run error panel (#498). Run errors arrive as plain
// strings (e.g. an OpenAI 401 "… find your API key at https://…"); split the
// text into plain + clickable URL segments so provider links are actionable, and
// expose the in-app provider-settings route so the user can fix the key directly.

export type ErrorSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string };

// Trailing sentence punctuation must stay out of the href so "…api-keys."
// doesn't linkify the period. A backward char-walk (not a `/[…]+$/` regex) keeps
// this linear — an anchored-quantifier regex scanned from each start position is
// polynomial (ReDoS) on inputs like "https://!!!!!!!".
const TRAILING_PUNCT_CHARS = new Set([
  ".", ",", ";", ":", "!", "?", "'", '"', ")", "]",
]);

export function linkifyErrorText(text: string): ErrorSegment[] {
  const segments: ErrorSegment[] = [];
  const re = /https?:\/\/\S+/g;
  let last = 0;
  for (const match of text.matchAll(re)) {
    const raw = match[0];
    const start = match.index ?? 0;
    let end = raw.length;
    while (end > 0 && TRAILING_PUNCT_CHARS.has(raw[end - 1])) end--;
    const url = raw.slice(0, end);
    const trail = raw.slice(end);
    if (start > last) {
      segments.push({ kind: "text", value: text.slice(last, start) });
    }
    if (url) segments.push({ kind: "link", value: url, href: url });
    if (trail) segments.push({ kind: "text", value: trail });
    last = start + raw.length;
  }
  if (last < text.length) {
    segments.push({ kind: "text", value: text.slice(last) });
  }
  if (segments.length === 0) segments.push({ kind: "text", value: text });
  return segments;
}

// In-app route to the AI-provider key settings (opens the OpenAI key modal), so
// the error panel can link the user straight to where the key is fixed.
export const LLM_PROVIDER_SETTINGS_HREF = "/configuration/llm?modal=openai";

// Whether an error is specifically an OpenAI API-key failure. The CTA routes to
// the OpenAI key modal, so it must only surface for that exact case. Require BOTH
// explicit "api key" phrasing AND OpenAI context — so it does NOT fire on a bare
// 401/Unauthorized, on a *tool/connector* "invalid API key" (e.g. a GitHub
// token), or on another provider's key error (e.g. Anthropic's "x-api-key"),
// all of which would otherwise point the user at the wrong (OpenAI) modal.
const API_KEY_RE = /\bapi[ _-]?keys?\b/i;
const OPENAI_RE = /openai/i;

export function isOpenAiKeyError(text: string): boolean {
  return API_KEY_RE.test(text) && OPENAI_RE.test(text);
}
