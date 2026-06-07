/**
 * TDD gate for bug: parseMentions incorrectly extracts @handles from URLs.
 *
 * Root cause (debug session: chat-no-assistant-response):
 *   MENTION_RE = /@([a-z0-9_-]+)/gi matches any @-prefixed identifier,
 *   including those in URL paths like https://www.youtube.com/@theericriesshow.
 *   When the resolved mention array is empty (URL @-handle is not an assistant user),
 *   resolveMessageRouting returns { shouldCallLlm: false, isBroadcast: true },
 *   causing sendMessage to skip streamResponse — no assistant reply, no Thinking dot,
 *   no console error.
 *
 * Fix required:
 *   parseMentions must NOT match @handles that are part of a URL.
 *   A URL @-handle appears after a "/" in a URL-like context.
 *
 * These tests MUST FAIL before the fix is applied.
 *
 * NOTE: This test imports directly from mentions-pure.ts (the pure-function
 * extraction of parseMentions), which has no server-only or DB dependencies.
 * The fix requires splitting parseMentions out of mentions.ts into a dedicated
 * pure module: packages/chat/src/mentions-pure.ts.
 */

import { describe, it, expect } from "vitest";
import { parseMentions } from "../mentions-pure";

describe("parseMentions — URL @-handle safety (bug: chat-no-assistant-response)", () => {
  // ---------------------------------------------------------------------------
  // FAILING CASES — must pass after the fix
  // ---------------------------------------------------------------------------

  it("does not match @channel in a YouTube URL", () => {
    const mentions = parseMentions(
      "Show me all episodes related to open source at https://www.youtube.com/@theericriesshow.",
    );
    // Before the fix this returns [{ handle: "theericriesshow", ... }].
    // After the fix it must return [].
    expect(mentions).toHaveLength(0);
  });

  it("does not match @username at the end of any https:// URL path", () => {
    const mentions = parseMentions("Follow https://twitter.com/@handle for updates.");
    expect(mentions).toHaveLength(0);
  });

  it("does not match @username in a URL with a trailing path segment", () => {
    const mentions = parseMentions(
      "Check out https://instagram.com/@photographer/posts for examples.",
    );
    expect(mentions).toHaveLength(0);
  });

  it("does not match @username in a bare domain URL path", () => {
    const mentions = parseMentions("Visit example.com/@user to see the profile.");
    expect(mentions).toHaveLength(0);
  });

  it("does not match @channel URL with query params", () => {
    const mentions = parseMentions(
      "https://www.youtube.com/@theericriesshow/videos?sort=da",
    );
    expect(mentions).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // PASSING CASES — must continue to pass after the fix
  // ---------------------------------------------------------------------------

  it("still matches a valid @cinatra mention at a word boundary", () => {
    const mentions = parseMentions("@cinatra can you help me?");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].handle).toBe("cinatra");
  });

  it("still matches @handle that is not inside a URL", () => {
    const mentions = parseMentions("Ask @alice to review this please.");
    expect(mentions).toHaveLength(1);
    expect(mentions[0].handle).toBe("alice");
  });

  it("matches standalone @handle but ignores the @channel in a URL in the same message", () => {
    const mentions = parseMentions(
      "@cinatra please summarize https://www.youtube.com/@theericriesshow",
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].handle).toBe("cinatra");
  });

  it("returns empty array for a message with no mentions and no URLs", () => {
    const mentions = parseMentions("Hello, can you help me with my account?");
    expect(mentions).toHaveLength(0);
  });

  it("returns empty array for a URL-only message", () => {
    const mentions = parseMentions("https://www.youtube.com/@theericriesshow");
    expect(mentions).toHaveLength(0);
  });

  it("matches multiple standalone @handles", () => {
    const mentions = parseMentions("@alice and @bob please review");
    expect(mentions).toHaveLength(2);
    expect(mentions.map((m) => m.handle)).toEqual(["alice", "bob"]);
  });
});
