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
          "Run @cinatra-ai/skill-recommender-agent so I can confirm which installed skills apply to the next step",
        ),
      ),
    ).toBe("@cinatra-ai/skill-recommender-agent");
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

  it("Use the @cinatra-ai/auditor-agent", () => {
    expect(
      detectExplicitDispatchPackage(
        u(
          "Use the @cinatra-ai/auditor-agent agent to audit the agent definition at https://example.com — I'll approve the findings once you produce them.",
        ),
      ),
    ).toBe("@cinatra-ai/auditor-agent");
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
