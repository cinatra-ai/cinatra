/**
 * Regression gate for the chat silent-reply bug.
 *
 * `parseMentions` regex `/(?<![/.:])@([a-z0-9_-]+)/gi` correctly matches
 * `@handle` tokens but ALSO matches the `@cinatra-ai` prefix of package
 * references like `@cinatra-ai/contact-discovery-agent`. The captured token
 * resolves to no assistant user, so the chat used to short-circuit
 * to a silent empty reply.
 *
 * The fix is at the resolver / routing layer — `resolved.length === 0`
 * now falls through to the no-mention broadcast branch. The parser regex
 * stays permissive on purpose (refining it would break valid `@handle` cases
 * inside markdown / quoted text). This test documents the parser's
 * false-positive shape so future regression analysis has a fast pointer:
 *
 *   "Why does the chat sometimes look like it has @-mentions but resolves
 *    to nothing? Because of THIS line in the user prompt."
 *
 * If a future fix tightens the parser to reject this case explicitly, this
 * test should be UPDATED in lockstep with the routing-layer fallback so
 * the contract stays: parser-permissive + resolver-tolerant.
 */
import { describe, it, expect } from "vitest";
import { parseMentions } from "../mentions-pure";

describe("parseMentions — package-ref false-positive contract (regression gate)", () => {
  it("matches @cinatra-ai from a `@cinatra-ai/<slug>` package reference", () => {
    const mentions = parseMentions(
      "Use the @cinatra-ai/contact-discovery-agent to discover contacts.",
    );
    // The captured raw handle is "cinatra-ai" — this is the false-positive
    // that triggers the empty-resolve fall-through.
    expect(mentions).toHaveLength(1);
    expect(mentions[0]?.handle).toBe("cinatra-ai");
  });

  it("matches the first @<token> from multiple package references in one message", () => {
    const mentions = parseMentions(
      "Run @cinatra-ai/apollo-prospecting-agent then @cinatra-ai/contact-discovery-agent.",
    );
    // Both `@cinatra-ai` instances are captured as separate raw mentions; both
    // resolve to nothing → routing must fall through to broadcast for both.
    expect(mentions.length).toBeGreaterThanOrEqual(1);
    for (const m of mentions) {
      expect(m.handle).toBe("cinatra-ai");
    }
  });

  it("DOES match a real @handle when one is present alongside a package reference", () => {
    // A user might mention an actual assistant AND reference a package by
    // name in the same message. The parser MUST still capture the assistant
    // mention; the resolver-layer fall-through only fires when EVERY raw
    // mention resolves empty, not when some resolve.
    const mentions = parseMentions(
      "@cinatra please run @cinatra-ai/apollo-prospecting-agent on acme.com",
    );
    // Two raw mentions: "cinatra" + "cinatra-ai". After resolveMentions(),
    // "cinatra" resolves to the assistant, "cinatra-ai" does not — the
    // resolver returns 1 mention, which is non-empty, so the broadcast
    // fall-through correctly does NOT fire here.
    const handles = mentions.map((m) => m.handle).sort();
    expect(handles).toEqual(["cinatra", "cinatra-ai"]);
  });

  it("DOES NOT match @handles inside URLs (existing URL-safety contract, preserved)", () => {
    // Regression cross-check with the existing parse-mentions URL safety
    // contract: this test exists so a future "broaden parser" fix can't
    // accidentally reintroduce URL false-positives without failing here.
    const mentions = parseMentions(
      "Check https://www.youtube.com/@theericriesshow.",
    );
    expect(mentions).toHaveLength(0);
  });
});
