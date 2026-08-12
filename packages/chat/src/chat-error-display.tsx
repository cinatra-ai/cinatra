import Link from "next/link";
import { AppRouteLink } from "./app-route-link";

// Pure helpers for the chat error card (#534). Mirrors the established
// agent-run error pattern from @cinatra-ai/agents' agent-error-display.ts
// (#498): run errors arrive as plain provider strings (e.g. an OpenAI 401
// "… find your API key at https://…"). Split the text into plain + clickable
// URL segments so provider links are actionable, and expose the in-app
// provider-settings route so the user can fix the key directly.
//
// These helpers are replicated (not imported) because agent-error-display.ts is
// internal to @cinatra-ai/agents — it is neither in that package's `exports`
// map nor re-exported from its index — so reusing it would require widening the
// agents public surface (a new cross-package dependency the issue rules out).

export type ErrorSegment =
  | { kind: "text"; value: string }
  // `external: false` = an IN-APP route (cinatra#2526): rendered as a
  // same-tab next/link, never `target="_blank"`.
  | { kind: "link"; value: string; href: string; external: boolean };

// Trailing sentence punctuation must stay out of the href so "…api-keys."
// doesn't linkify the period. A backward char-walk (not a `/[…]+$/` regex) keeps
// this linear — an anchored-quantifier regex scanned from each start position is
// polynomial (ReDoS) on inputs like "https://!!!!!!!".
const TRAILING_PUNCT_CHARS = new Set([
  ".", ",", ";", ":", "!", "?", "'", '"', ")", "]",
]);

// One pass, two alternatives — ORDER MATTERS.
//
//   1. an absolute provider URL (as before), and
//   2. cinatra#2526 — an IN-APP absolute route, e.g.
//      "/configuration/development?tab=tunnel". Operator-facing strings name
//      the exact page that fixes the problem; rendered as dead text the user
//      has to retype it by hand.
//
// The URL alternative is listed first and `matchAll` advances past the whole
// match, so the path INSIDE a matched URL is never rescanned as an app route.
//
// Deliberately conservative, because this runs over arbitrary provider prose:
//   - `(?<![\w@/])` — the slash must open a token, so "N/A", "and/or", "24/7"
//     and an email local-part never linkify.
//   - `\/[a-z]` — a route starts with a lowercase letter, so "/2" or "/ " is
//     not a route.
//   - the query class excludes "." so a sentence-ending period after
//     "?tab=tunnel" stays text (the punct-walk below covers the path case).
// No nested quantifier shares a prefix (each repeat must start with "/", which
// the inner class excludes), so this stays linear — no ReDoS.
const LINKIFY_RE =
  /https?:\/\/\S+|(?<![\w@/])\/[a-z][a-z0-9\-]*(?:\/[a-zA-Z0-9\-._~%]+)*(?:\?[a-zA-Z0-9\-._~%=&+]*)?/g;

export function linkifyErrorText(text: string): ErrorSegment[] {
  const segments: ErrorSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(LINKIFY_RE)) {
    const raw = match[0];
    const start = match.index ?? 0;
    let end = raw.length;
    while (end > 0 && TRAILING_PUNCT_CHARS.has(raw[end - 1])) end--;
    const href = raw.slice(0, end);
    const trail = raw.slice(end);
    if (start > last) {
      segments.push({ kind: "text", value: text.slice(last, start) });
    }
    if (href) {
      segments.push({
        kind: "link",
        value: href,
        href,
        external: !href.startsWith("/"),
      });
    }
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
// the error card can link the user straight to where the key is fixed.
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

// Presentational body of the chat error card (#534): the "Something went wrong"
// heading plus the friendly message. Long unbreakable provider tokens (e.g. a
// masked sk-proj-… key in a raw "401 Incorrect API key provided …" string)
// overflowed the card horizontally; the caller constrains the container
// (max-w-full overflow-hidden) and this wraps with whitespace-pre-wrap
// break-all. Linkify provider URLs so they are actionable, and surface the
// in-app key-settings CTA for recognized OpenAI key errors. Mirrors the
// agent-run panel.
export function FriendlyErrorBody({ error }: { error: string }) {
  return (
    <>
      <p className="text-sm font-medium text-destructive">Something went wrong</p>
      <p className="mt-0.5 whitespace-pre-wrap break-all text-sm text-destructive/80">
        {linkifyErrorText(error).map((seg, i) =>
          seg.kind === "link" ? (
            seg.external ? (
              <Link
                key={i}
                href={seg.href}
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2"
              >
                {seg.value}
              </Link>
            ) : (
              // An in-app route navigates IN PLACE on a first-party surface
              // (cinatra#2526) — and must not, inside the sandboxed widget
              // frame, where that would replace the assistant with a Cinatra
              // page the reader cannot use there. `AppRouteLink` applies the
              // host's link policy (cinatra#2683); the href is untouched.
              <AppRouteLink
                key={i}
                href={seg.href}
                className="underline underline-offset-2"
              >
                {seg.value}
              </AppRouteLink>
            )
          ) : (
            <span key={i}>{seg.value}</span>
          ),
        )}
      </p>
      {isOpenAiKeyError(error) && (
        <AppRouteLink
          href={LLM_PROVIDER_SETTINGS_HREF}
          className="mt-2 inline-flex text-xs font-medium text-destructive underline underline-offset-2"
        >
          Update your OpenAI API key →
        </AppRouteLink>
      )}
    </>
  );
}
