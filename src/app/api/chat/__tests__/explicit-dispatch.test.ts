import { describe, it, expect } from "vitest";
import {
  detectExplicitDispatchPackage,
  detectExplicitDispatchDirective,
} from "../explicit-dispatch";

// Deterministic pre-router unit tests.
// Coverage: every chat-mcp fixture prompt MUST resolve to the
// correct packageName (the routing-gap goes from probabilistic to
// deterministic via this regex layer).

const u = (content: string) => [{ role: "user", content }];

describe("detectExplicitDispatchPackage — chat-mcp fixture prompts", () => {
  it("Use the @cinatra-ai/<slug> agent (canonical, 'Use' verb)", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/email-test-delivery-agent agent to fetch the page title at https://example.com",
        ),
      ),
    ).toBe("@cinatra-ai/email-test-delivery-agent");
  });

  it("Run @cinatra-ai/<slug> (bare 'Run' verb)", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Run @cinatra-ai/web-research-agent so I can pull background on the next account",
        ),
      ),
    ).toBe("@cinatra-ai/web-research-agent");
  });

  it("legacy 'Invoke the cinatra_<slug> tool' → maps to @cinatra-ai/<slug>", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Invoke the cinatra_trigger-agent tool to configure an immediate trigger. The agent will pause on its configure HITL gate for me to confirm.",
        ),
      ),
    ).toBe("@cinatra-ai/trigger-agent");
  });

  it("Use the @cinatra-ai/author-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/author-agent agent to audit the agent definition at https://example.com — I'll approve the findings once you produce them.",
        ),
      ),
    ).toBe("@cinatra-ai/author-agent");
  });

  it("Use the @cinatra-ai/list-curator-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/list-curator-agent agent to curate a list from https://example.com and surface it for my approval.",
        ),
      ),
    ).toBe("@cinatra-ai/list-curator-agent");
  });

  it("'Use the @cinatra-ai/web-scrape-agent to scrape...'", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/web-scrape-agent to scrape the example page at https://example.com — extract the page title and main text.",
        ),
      ),
    ).toBe("@cinatra-ai/web-scrape-agent");
  });

  it("Use @cinatra-ai/web-research-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/web-research-agent to research the topic 'example.com' and return a short summary.",
        ),
      ),
    ).toBe("@cinatra-ai/web-research-agent");
  });

  it("Use @cinatra-ai/media-feed-lister-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/media-feed-lister-agent to list episodes from the RSS feed https://www.example.com/feed.xml — fall back to an empty list if the feed is empty.",
        ),
      ),
    ).toBe("@cinatra-ai/media-feed-lister-agent");
  });

  it("Use @cinatra-ai/media-transcript-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/media-transcript-agent to produce a transcript from the public YouTube video https://www.youtube.com/watch?v=jNQXAC9IVRw — keep it short, this is a smoke test.",
        ),
      ),
    ).toBe("@cinatra-ai/media-transcript-agent");
  });

  it("'Invoke the @cinatra-ai/blog-idea-generator-agent'", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Invoke the @cinatra-ai/blog-idea-generator-agent for the topic 'example domains' — generate one short blog idea.",
        ),
      ),
    ).toBe("@cinatra-ai/blog-idea-generator-agent");
  });

  it("Use @cinatra-ai/blog-draft-writer-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/blog-draft-writer-agent to draft a short blog post about 'example domains' — keep it under 100 words.",
        ),
      ),
    ).toBe("@cinatra-ai/blog-draft-writer-agent");
  });

  it("Use @cinatra-ai/blog-image-prompt-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/blog-image-prompt-agent to generate an image prompt for a blog post about 'example domains'.",
        ),
      ),
    ).toBe("@cinatra-ai/blog-image-prompt-agent");
  });

  it("Use @cinatra-ai/company-discovery-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/company-discovery-agent to discover information about the company at https://example.com",
        ),
      ),
    ).toBe("@cinatra-ai/company-discovery-agent");
  });

  it("Use @cinatra-ai/contact-discovery-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/contact-discovery-agent to discover contact info for the example company at https://example.com",
        ),
      ),
    ).toBe("@cinatra-ai/contact-discovery-agent");
  });

  it("Use @cinatra-ai/planner-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/planner-agent to plan a short agent that fetches a URL title and returns it.",
        ),
      ),
    ).toBe("@cinatra-ai/planner-agent");
  });

  it("Use @cinatra-ai/code-reviewer-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/code-reviewer-agent to review a trivial example: `def hello(): return 'world'` — flag style only.",
        ),
      ),
    ).toBe("@cinatra-ai/code-reviewer-agent");
  });

  it("Use @cinatra-ai/security-reviewer-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/security-reviewer-agent to security-review a trivial example: `def hello(): return 'world'` — return no findings.",
        ),
      ),
    ).toBe("@cinatra-ai/security-reviewer-agent");
  });

  it("Use @cinatra-ai/lint-policy-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u("Use the @cinatra-ai/lint-policy-agent to lint a trivial agent definition."),
      ),
    ).toBe("@cinatra-ai/lint-policy-agent");
  });
});

describe("detectExplicitDispatchPackage — hedge / negative cases", () => {
  it("informational query about an agent (no dispatch verb) → null", () => {
    expect(
      detectExplicitDispatchPackage(
        u("Tell me about @cinatra-ai/email-test-delivery-agent — what does it do?"),
      ),
    ).toBeNull();
  });

  it("comparison query → null (no dispatch verb)", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Compare @cinatra-ai/web-scrape-agent and @cinatra-ai/web-research-agent",
        ),
      ),
    ).toBeNull();
  });

  it("'which agent can scrape a web page?' → null", () => {
    expect(
      detectExplicitDispatchPackage(u("Which agent can scrape a web page?")),
    ).toBeNull();
  });

  it("empty conversation → null", () => {
    expect(detectExplicitDispatchPackage([])).toBeNull();
  });

  it("verb present but no agent reference → null", () => {
    expect(
      detectExplicitDispatchPackage(
        u("Use markdown formatting in your responses please"),
      ),
    ).toBeNull();
  });

  it("only the assistant role is the last message → null (no user)", () => {
    expect(
      detectExplicitDispatchPackage([
        { role: "user", content: "Use @cinatra-ai/web-scrape-agent" },
        { role: "assistant", content: "Sure, dispatching." },
      ]),
    ).toBeNull();
  });
});

describe("detectExplicitDispatchPackage — case parity with the client tokenizer", () => {
  // cinatra#2820 review. The client mention tokenizer lexes scoped refs
  // case-insensitively (`packages/chat/src/mention-tokenizer.ts` — MENTION_RE
  // carries `/gi`) and lowercases vendor+slug, so a capitalized ref classifies
  // `agent-dispatch` and takes the STREAMING route just like the lowercase form.
  // While this matcher read the raw text it found nothing, so the message
  // streamed and no agent ran: the #2820 defect on a case variant. Every arm
  // below is RED before the case fold in `detectExplicitDispatchPackage`.
  //
  // SCOPE (cinatra#2912 review, NEW-1). The fold covers the CANONICAL
  // `@vendor/slug` form ONLY. The legacy `cinatra_<slug>` form has no client
  // counterpart to be in parity with, so it stays case-SENSITIVE; the
  // `case parity STOPS at the canonical form` block below pins that.

  it("the canonical form in mixed case resolves to the lowercase packageName", () => {
    expect(
      detectExplicitDispatchPackage(
        u("Use @Cinatra-AI/Some-Agent to find leads at Acme"),
      ),
    ).toBe("@cinatra-ai/some-agent");
  });

  it("a SHOUTED canonical form resolves too", () => {
    expect(
      detectExplicitDispatchPackage(
        u("RUN @CINATRA-AI/CONTACT-DISCOVERY-AGENT ON THIS ACCOUNT"),
      ),
    ).toBe("@cinatra-ai/contact-discovery-agent");
  });

  it("a capitalized vendor with a lowercase slug resolves", () => {
    expect(
      detectExplicitDispatchPackage(
        u("Invoke @Cinatra-ai/planner-agent to sketch the flow"),
      ),
    ).toBe("@cinatra-ai/planner-agent");
  });

  it("HEDGE — case-insensitivity does NOT weaken the verb hedge", () => {
    // Still no dispatch verb: an informational query stays null whatever its case.
    expect(
      detectExplicitDispatchPackage(
        u("Tell me about @Cinatra-AI/Some-Agent — what does it do?"),
      ),
    ).toBeNull();
  });

  it("the legacy underscore form still resolves in its own lowercase shape", () => {
    // The narrowing is about CASE, not about dropping legacy support: the form
    // the fixtures and operator prompts actually carry keeps working.
    expect(
      detectExplicitDispatchPackage(
        u("Invoke the cinatra_trigger-agent tool to configure a trigger"),
      ),
    ).toBe("@cinatra-ai/trigger-agent");
  });

  it("emits the directive for the mixed-case form, naming the lowercase package", () => {
    const out = detectExplicitDispatchDirective(
      u("Use @Cinatra-AI/Contact-Discovery-Agent to find leads at Acme"),
    );
    expect(out).toMatch(/DETECTED EXPLICIT AGENT DISPATCH/);
    expect(out).toMatch(/@cinatra-ai\/contact-discovery-agent/);
    // The directive must never echo the user's casing into `packageName` — a
    // capitalized packageName is not installable.
    expect(out).not.toMatch(/Cinatra-AI/);
  });
});

describe("detectExplicitDispatchPackage — case parity STOPS at the canonical form", () => {
  // cinatra#2912 review, NEW-1. An earlier revision lowercased the WHOLE
  // message before BOTH matchers. That is right for the canonical
  // `@vendor/slug` form, which mirrors a client tokenizer that lexes
  // case-insensitively. It is wrong for the legacy `cinatra_<slug>` form: the
  // tokenizer only ever lexes `@`-mentions, so the legacy form produces no
  // mention token at all and has NO client behaviour to be in parity with
  // (pinned at
  // `packages/chat/src/__tests__/scoped-agent-dispatch-streams.test.ts` —
  // "No mention token at all").
  //
  // Folding case for it only widened the matcher onto ordinary SHOUTED
  // identifiers. The tree ships `CINATRA_THEME`, `CINATRA_ID`,
  // `CINATRA_STATUS`, `CINATRA_LOGO` and more as plain identifiers in `src/`,
  // `packages/`, `docs/` and `.github/`. A non-null return here is a HARD
  // short-circuit before the model layer (`src/lib/assistant-runtime/runtime.ts`
  // — it calls `serverSideExplicitDispatch` and emits synthetic
  // `tool_call`/`tool_result` SSE events), so a user asking a configuration
  // question about one of those names would get a spurious FAILED agent
  // dispatch rendered in their thread before any answer — and none at all if
  // the failure classifies terminal.
  //
  // Every arm below is RED while the whole message is lowercased, and GREEN
  // once the fold is narrowed to the canonical matcher.

  it("a SHOUTED single-segment identifier does NOT dispatch", () => {
    expect(
      detectExplicitDispatchPackage(u("Use CINATRA_THEME to change the look")),
    ).toBeNull();
  });

  it("a SHOUTED identifier behind another dispatch verb does NOT dispatch", () => {
    expect(
      detectExplicitDispatchPackage(u("How do I run CINATRA_STATUS?")),
    ).toBeNull();
  });

  it("a capitalized legacy ref does NOT dispatch", () => {
    // This arm previously asserted the OPPOSITE and pinned the widening as
    // correct. It is flipped on purpose: there is no client counterpart for
    // the legacy form, so a capitalized spelling of it carries no dispatch
    // intent the server may act on unilaterally.
    expect(
      detectExplicitDispatchPackage(
        u("Invoke the Cinatra_Trigger-Agent Tool to configure a trigger"),
      ),
    ).toBeNull();
  });

  it("a multi-segment SHOUTED identifier stays null (it always did)", () => {
    // Regression guard, not a fix: the trailing underscore blocks the `\b`, so
    // this shape was never affected either way.
    expect(
      detectExplicitDispatchPackage(u("Use the CINATRA_AGENT_ID value")),
    ).toBeNull();
  });

  it("the canonical fold is UNAFFECTED by the narrowing", () => {
    // The #2820 case-variant fix must survive: this is the arm the prior round
    // added, restated here so the narrowing cannot silently undo it.
    expect(
      detectExplicitDispatchPackage(
        u("Use @Cinatra-AI/Contact-Discovery-Agent to find leads at Acme"),
      ),
    ).toBe("@cinatra-ai/contact-discovery-agent");
  });
});

describe("detectExplicitDispatchDirective — directive emission", () => {
  it("emits non-empty directive on canonical match", () => {
    const out = detectExplicitDispatchDirective(
      u("Use @cinatra-ai/email-test-delivery-agent to send a test email"),
    );
    expect(out).toMatch(/DETECTED EXPLICIT AGENT DISPATCH/);
    expect(out).toMatch(/@cinatra-ai\/email-test-delivery-agent/);
    expect(out).toMatch(/FIRST external action MUST be `agent_run`/);
    expect(out).toMatch(/agent_run_get/);
  });

  it("emits empty string on no-match (LLM follows normal SKILL guidance)", () => {
    expect(
      detectExplicitDispatchDirective(
        u("Tell me about your installed agents"),
      ),
    ).toBe("");
  });
});
