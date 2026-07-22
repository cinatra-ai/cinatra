/**
 * Lockstep semantics for the mention tokenizer vs. the flat-mention parser
 * (cinatra#1875 W2, Epic #1873 — AC#1). Rewritten from the legacy
 * "parser-permissive + resolver-tolerant" contract.
 *
 * The old `parseMentions` regex mis-lexed a `@vendor/slug` package reference
 * (e.g. `@cinatra-ai/contact-discovery-agent`) as a FLAT `@cinatra-ai` handle —
 * a false positive that resolved to no assistant and forced a resolver-layer
 * fall-through. The shared tokenizer now lexes scoped `@vendor/slug` as a
 * distinct SCOPED token, so:
 *
 *   - `parseMentions` (the FLAT feed) NO LONGER emits a bogus `cinatra-ai`
 *     handle for a package reference — the false positive is gone at the lexer;
 *   - `tokenizeMentions` surfaces the scoped token with vendor + slug, which
 *     phase-2 classification routes to an assistant mention (if registered +
 *     in-audience) or to `agent_run` dispatch (otherwise).
 *
 * A future change to the tokenizer MUST keep this lockstep: scoped stays scoped,
 * flat stays flat, and neither leaks into the other.
 */
import { describe, it, expect } from "vitest";
import { parseMentions } from "../mentions-pure";
import { tokenizeMentions } from "../mention-tokenizer";

describe("parseMentions — flat feed excludes scoped package references (AC#1 lockstep)", () => {
  it("emits NO flat mention for a lone `@vendor/slug` package reference", () => {
    // Was: `[{ handle: "cinatra-ai" }]` (the false positive). Now: `[]`.
    const mentions = parseMentions(
      "Use the @cinatra-ai/contact-discovery-agent to discover contacts.",
    );
    expect(mentions).toEqual([]);
  });

  it("emits NO flat mention for multiple package references in one message", () => {
    const mentions = parseMentions(
      "Run @cinatra-ai/apollo-prospecting-agent then @cinatra-ai/contact-discovery-agent.",
    );
    expect(mentions).toEqual([]);
  });

  it("emits ONLY the real flat handle when a mention sits alongside a package reference", () => {
    const mentions = parseMentions(
      "@cinatra please run @cinatra-ai/apollo-prospecting-agent on acme.com",
    );
    // The scoped ref no longer contaminates the flat feed — only `cinatra`.
    expect(mentions.map((m) => m.handle)).toEqual(["cinatra"]);
  });

  it("still excludes @handles inside URLs (URL-safety contract preserved)", () => {
    const mentions = parseMentions("Check https://www.youtube.com/@theericriesshow.");
    expect(mentions).toEqual([]);
  });
});

describe("tokenizeMentions — scoped vs flat lexing (AC#1)", () => {
  it("lexes `@vendor/slug` as ONE scoped token with vendor + slug + packageRef", () => {
    const tokens = tokenizeMentions(
      "Use the @cinatra-ai/contact-discovery-agent to discover contacts.",
    );
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      kind: "scoped",
      vendor: "cinatra-ai",
      slug: "contact-discovery-agent",
      packageRef: "@cinatra-ai/contact-discovery-agent",
      handle: "contact-discovery-agent",
    });
    // Never a flat `cinatra-ai` alongside it.
    expect(tokens.filter((t) => t.kind === "flat")).toHaveLength(0);
  });

  it("distinguishes a flat handle from a scoped ref in the same message", () => {
    const tokens = tokenizeMentions(
      "@cinatra please run @cinatra-ai/apollo-prospecting-agent",
    );
    expect(tokens.map((t) => t.kind)).toEqual(["flat", "scoped"]);
    expect(tokens[0]).toMatchObject({ kind: "flat", handle: "cinatra" });
    expect(tokens[1]).toMatchObject({ kind: "scoped", packageRef: "@cinatra-ai/apollo-prospecting-agent" });
  });

  it("preserves offsets/lengths for both kinds", () => {
    const content = "hi @gemini and @cinatra-ai/x";
    const tokens = tokenizeMentions(content);
    for (const t of tokens) {
      expect(content.slice(t.offset, t.offset + t.length)).toBe(t.raw);
    }
  });
});
