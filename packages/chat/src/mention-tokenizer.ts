/**
 * Shared mention TOKENIZER (cinatra#1875 W2, Epic #1873 — AC#1, phase 1).
 *
 * ONE lexical primitive for every `@`-mention surface, replacing the ad-hoc
 * per-site regexes (parseMentions, the routing count, the message-render split,
 * the autocomplete trigger). It emits a typed token stream so the two-phase
 * classifier (phase 2, `classify-mentions.ts`) — and every consumer — sees the
 * SAME lexing, in particular the scoped-vs-flat distinction that the old
 * flat-only regex could not make.
 *
 *   kind: "scoped"  →  `@vendor/slug`   (a package reference, e.g.
 *                      `@cinatra-ai/gemini-assistant`). `vendor` + `slug` are
 *                      captured; `packageRef` is the canonical `@vendor/slug`.
 *   kind: "flat"    →  `@handle`        (a bare mention handle / alias, e.g.
 *                      `@cinatra`, `@gemini`). `handle` is the lowercased token.
 *
 * SCOPED IS TRIED FIRST: `@vendor/slug` matches as one scoped token, so
 * `@cinatra-ai/gemini-assistant` is NEVER mis-lexed as a flat `@cinatra-ai`
 * (the old false-positive that made `parseMentions` return a bogus `cinatra-ai`
 * handle). Phase 2 then decides whether a scoped token names a registered,
 * in-audience assistant (⇒ assistant mention) or is an `agent_run` dispatch ref.
 *
 * GUARDS (preserved + tightened):
 *   - URL guard  — an `@` immediately preceded by `/`, `.`, `:` or `=` is skipped,
 *     so URL-path/query handles (`youtube.com/@channel`, `x.test?q=@channel`)
 *     never lex.
 *   - EMAIL guard — an `@` immediately preceded by an email local-part char
 *     (word char, `+`, `%`) is skipped, so an address local-part
 *     (`user@example.com`, `foo+tag@example.com`) never lexes as `@example`.
 *   - a doubled `@@` never starts a token.
 *   - RIGHT boundary — a token must be followed by a non-token char, so a scoped
 *     `@vendor/slug` is never TRUNCATED out of a longer path/identifier
 *     (`@foo/bar/baz`, `@foo/bar_baz` do not partially match `@foo/bar` and
 *     mis-dispatch the wrong package — they simply do not lex).
 *
 * Pure + dependency-free (no server-only, no DB) so client components, the
 * server routers, and unit tests share ONE definition.
 */

/** A lexed mention token (phase-1 output). */
export type MentionToken = {
  /** The full matched text INCLUDING the leading `@` (e.g. `@cinatra-ai/x`). */
  raw: string;
  kind: "scoped" | "flat";
  /** flat: the lowercased handle. scoped: the lowercased slug (see `packageRef`). */
  handle: string;
  /** scoped only: the vendor segment (lowercased). */
  vendor?: string;
  /** scoped only: the slug segment (lowercased). */
  slug?: string;
  /** scoped only: the canonical `@vendor/slug` package reference (lowercased). */
  packageRef?: string;
  /** 0-based index of the leading `@` within the source string. */
  offset: number;
  /** Character length of `raw`. */
  length: number;
};

// One scan. Scoped alternative FIRST (regex alternation is ordered, so
// `vendor/slug` is preferred over a bare `vendor`). The lookbehind carries the
// URL guard (`/.:=`), the email guard (word char `\w` + `+` + `%` — the common
// local-part chars that can immediately precede `@`), and the doubled-`@` guard.
// The trailing lookahead `(?![\w/-])` is the RIGHT boundary: a token must end at
// a non-token char, so a scoped ref is never truncated out of a longer path
// (`@foo/bar/baz`) or identifier (`@foo/bar_baz`). Segment shapes mirror the npm
// scope grammar the rest of the codebase uses: start alnum, then alnum/hyphen.
// The flat class keeps the historical `[a-z0-9_-]+` so existing flat handles
// (with `_`) still lex.
const MENTION_RE =
  /(?<![\w/.:@+%=])@(?:([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)|([a-z0-9_-]+))(?![\w/-])/gi;

/**
 * Tokenize every `@`-mention in `content` into the typed stream. Scoped tokens
 * are emitted before/instead of a flat mis-read of their vendor segment; URL and
 * email `@`s are skipped. Offsets/lengths are exact for render + chip use.
 */
export function tokenizeMentions(content: string): MentionToken[] {
  const out: MentionToken[] = [];
  for (const m of content.matchAll(MENTION_RE)) {
    const raw = m[0];
    const offset = m.index ?? 0;
    const length = raw.length;
    const vendor = m[1];
    const slug = m[2];
    if (vendor && slug) {
      const v = vendor.toLowerCase();
      const s = slug.toLowerCase();
      out.push({
        raw,
        kind: "scoped",
        handle: s,
        vendor: v,
        slug: s,
        packageRef: `@${v}/${s}`,
        offset,
        length,
      });
    } else {
      out.push({
        raw,
        kind: "flat",
        handle: (m[3] ?? "").toLowerCase(),
        offset,
        length,
      });
    }
  }
  return out;
}

/** Only the flat tokens (bare `@handle` mentions), in source order. */
export function flatMentionTokens(content: string): MentionToken[] {
  return tokenizeMentions(content).filter((t) => t.kind === "flat");
}

/** Only the scoped tokens (`@vendor/slug` package references), in source order. */
export function scopedMentionTokens(content: string): MentionToken[] {
  return tokenizeMentions(content).filter((t) => t.kind === "scoped");
}
