// cinatra#1875 W2 (Epic #1873) — AC#1 phase 1: the shared mention tokenizer.
// Scoped-first lexing + the URL/email/doubled-@ guards.

import { describe, it, expect } from "vitest";
import {
  tokenizeMentions,
  flatMentionTokens,
  scopedMentionTokens,
} from "../mention-tokenizer";

describe("tokenizeMentions — flat tokens", () => {
  it("lexes a bare @handle at a word boundary", () => {
    expect(tokenizeMentions("@cinatra help").map((t) => ({ k: t.kind, h: t.handle }))).toEqual([
      { k: "flat", h: "cinatra" },
    ]);
  });

  it("lexes multiple flat handles in order and lowercases them", () => {
    expect(flatMentionTokens("@Alice and @BOB please").map((t) => t.handle)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("keeps underscores in flat handles", () => {
    expect(tokenizeMentions("@my_bot ping")[0]).toMatchObject({ kind: "flat", handle: "my_bot" });
  });
});

describe("tokenizeMentions — scoped tokens (tried first)", () => {
  it("lexes @vendor/slug as scoped, not flat vendor", () => {
    const [t] = scopedMentionTokens("ask @cinatra-ai/gemini-assistant to help");
    expect(t).toMatchObject({
      kind: "scoped",
      vendor: "cinatra-ai",
      slug: "gemini-assistant",
      packageRef: "@cinatra-ai/gemini-assistant",
    });
  });

  it("never emits a flat token for the vendor segment of a scoped ref", () => {
    const tokens = tokenizeMentions("@cinatra-ai/x");
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe("scoped");
  });
});

describe("tokenizeMentions — URL guard (preserved)", () => {
  it.each([
    "https://www.youtube.com/@theericriesshow",
    "https://twitter.com/@handle for updates",
    "https://instagram.com/@photographer/posts",
    "example.com/@user profile",
    "https://www.youtube.com/@chan/videos?sort=da",
  ])("does not lex an @handle inside a URL: %s", (text) => {
    expect(tokenizeMentions(text)).toEqual([]);
  });

  it("lexes a real mention but ignores the URL @handle in the same message", () => {
    const tokens = tokenizeMentions("@cinatra summarize https://youtube.com/@channel");
    expect(tokens.map((t) => t.handle)).toEqual(["cinatra"]);
  });
});

describe("tokenizeMentions — email guard", () => {
  it("does not lex an email local-part as a mention", () => {
    expect(tokenizeMentions("contact user@example.com for help")).toEqual([]);
  });

  it("does not lex a dotted-name email", () => {
    expect(tokenizeMentions("email john.doe@acme.io please")).toEqual([]);
  });

  it("does not lex a plus-tagged email local-part", () => {
    // `foo+@example.com` — the `@` follows `+` (a local-part char).
    expect(tokenizeMentions("mail foo+tag@example.com now")).toEqual([]);
    expect(tokenizeMentions("mail foo+@example.com now")).toEqual([]);
  });

  it("still lexes a mention adjacent to (but not part of) an email sentence", () => {
    const tokens = tokenizeMentions("mail me at a@b.com and ping @cinatra");
    expect(tokens.map((t) => t.handle)).toEqual(["cinatra"]);
  });
});

describe("tokenizeMentions — URL query guard + right boundary", () => {
  it("does not lex an @handle after a query-string '='", () => {
    expect(tokenizeMentions("https://x.test?q=@channel")).toEqual([]);
  });

  it("does NOT truncate a scoped ref out of a deeper path", () => {
    // `@foo/bar/baz` must not partial-match `@foo/bar` (wrong package dispatch).
    expect(tokenizeMentions("see @foo/bar/baz here")).toEqual([]);
  });

  it("does NOT truncate a scoped ref before an underscore tail", () => {
    // `@foo/bar_baz` — `_` is not a valid slug char; do not lex `@foo/bar`.
    expect(tokenizeMentions("run @foo/bar_baz now")).toEqual([]);
  });

  it("still lexes a well-formed scoped ref followed by punctuation", () => {
    const [t] = scopedMentionTokens("run @cinatra-ai/gemini-assistant, please");
    expect(t).toMatchObject({ kind: "scoped", packageRef: "@cinatra-ai/gemini-assistant" });
  });
});

describe("tokenizeMentions — doubled @", () => {
  it("does not start a token on the second @ of @@", () => {
    const tokens = tokenizeMentions("@@weird");
    // The first @ is followed by another @ (not a handle char) → no scoped/flat
    // match there; the run never yields a doubled token.
    expect(tokens.every((t) => t.handle !== "")).toBe(true);
    expect(tokens.some((t) => t.raw.startsWith("@@"))).toBe(false);
  });
});
