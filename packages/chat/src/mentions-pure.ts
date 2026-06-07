/**
 * Pure mention-parsing utilities — NO server-only imports, NO DB dependencies.
 *
 * Extracted from mentions.ts so:
 *  1. Client components and test files can import parseMentions without
 *     pulling in server-only/DB modules.
 *  2. parseMentions is independently testable without mocking the DB.
 *
 * Fix for bug chat-no-assistant-response:
 *   The original MENTION_RE = /@([a-z0-9_-]+)/gi matched @handles inside
 *   URLs (e.g. https://www.youtube.com/@theericriesshow). This caused
 *   resolveMessageRouting to return { shouldCallLlm: false } for any message
 *   containing a YouTube/Twitter/etc. URL with a channel handle, silently
 *   suppressing the LLM response with no error or UI feedback.
 *
 * The fix uses a negative lookbehind `(?<!\/)` to exclude @-matches that
 * immediately follow a `/` character (the URL path separator before a handle).
 * Additionally, a positive lookahead `(?=\s|$|[^a-z0-9_-])` is added as a
 * secondary guard — though the handle character class already limits greedy
 * matching. The key guard is `(?<!\/)`.
 */

export type RawMention = {
  handle: string;
  offset: number;
  length: number;
};

/**
 * URL-safe mention regex:
 *   - (?<!\/) — negative lookbehind: @handle must NOT be immediately preceded by "/"
 *     This excludes URL path handles like domain.com/@channel or https://x.com/@user
 *   - (?<![.:]) — also exclude after "." or ":" to further guard protocol/domain edge cases
 *   - @ — literal @
 *   - ([a-z0-9_-]+) — the handle (letters, digits, underscore, hyphen)
 *
 * Valid mention positions (examples that should match):
 *   "@cinatra please help"    → @cinatra at start
 *   "ask @alice to review"    → @alice after whitespace
 *   "cc @bob!"                → @bob before punctuation
 *
 * Invalid positions (examples that must NOT match):
 *   "https://www.youtube.com/@theericriesshow"  → / before @
 *   "https://twitter.com/@handle"               → / before @
 *   "example.com/@user"                         → / before @
 */
const MENTION_RE = /(?<![/.:])@([a-z0-9_-]+)/gi;

/**
 * Parse explicit @mentions from a chat message.
 * Skips @handles that appear inside URLs (after a "/" separator).
 *
 * @param content - The raw chat message text.
 * @returns Array of raw mentions with handle, offset, and length.
 */
export function parseMentions(content: string): RawMention[] {
  const out: RawMention[] = [];
  for (const m of content.matchAll(MENTION_RE)) {
    out.push({ handle: m[1].toLowerCase(), offset: m.index ?? 0, length: m[0].length });
  }
  return out;
}
