/**
 * Pure mention-parsing utilities — NO server-only imports, NO DB dependencies.
 *
 * `parseMentions` is now a thin projection over the shared mention TOKENIZER
 * (`./mention-tokenizer`, cinatra#1875 W2 AC#1): it returns the FLAT `@handle`
 * tokens only. A scoped `@vendor/slug` reference (e.g.
 * `@cinatra-ai/contact-discovery-agent`) is lexed as a distinct SCOPED token by
 * the tokenizer and is therefore NO LONGER mis-read here as a flat `@cinatra-ai`
 * handle — the historical false-positive (bug chat-no-assistant-response's
 * sibling) is resolved at the lexer instead of relying on a resolver-layer
 * fall-through. Scoped references flow to the explicit `agent_run` dispatch path
 * (or, once phase 2 resolves them, to an assistant mention), never to the flat
 * @-mention routing this function feeds.
 *
 * The URL/email guards live in the tokenizer and are preserved: URL-path handles
 * (`youtube.com/@channel`) and email local-parts (`user@example.com`) never lex.
 */

import { flatMentionTokens } from "./mention-tokenizer";

export type RawMention = {
  handle: string;
  offset: number;
  length: number;
};

/**
 * Parse explicit FLAT @mentions from a chat message (the routing/@-mention feed).
 * Scoped `@vendor/slug` references are intentionally EXCLUDED (they are package
 * references, surfaced by the tokenizer's scoped tokens). URL/email `@`s are
 * skipped by the shared tokenizer.
 *
 * @param content - The raw chat message text.
 * @returns Array of raw FLAT mentions with handle, offset, and length.
 */
export function parseMentions(content: string): RawMention[] {
  return flatMentionTokens(content).map((t) => ({
    handle: t.handle,
    offset: t.offset,
    length: t.length,
  }));
}
