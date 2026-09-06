/**
 * THE KIND PILL AND THE IDENTITY LINE, AS DRAWN (cinatra#3080, PR #3100, fix
 * leg 7).
 *
 * The eighth proof round measured the review target's kind pill reading "Blog
 * Post Artifact". Every pill the ratified drawing draws reads the KIND alone,
 * in sentence case: "Blog post" over `@cinatra-ai/blog:post`, "Slide deck" over
 * `@cinatra-ai/slide-deck-artifact:artifact`, "Screenshot" over
 * `@cinatra-ai/screenshot-artifact:artifact`, "Brand voice" over
 * `@cinatra-ai/brand-voice-artifact:artifact`.
 *
 * The same round measured the identity line carrying labelled prefixes
 * ("Ownership: organization · Visibility: organization") and a raw machine
 * timestamp, against the drawing's bare values and human-relative time:
 * "@cinatra-ai/email:draft · revision rev_8f3a… · pinned · Team · Private ·
 * text/html · updated 8 min ago".
 */
import { describe, expect, it } from "vitest";

import { reviewTypeLabel, reviewTargetRowFacts, reviewSettledCopy } from "../review-surface-model";

describe("the kind pill", () => {
  it("drops the packaging noun — a blog-post-artifact is a blog post", () => {
    expect(reviewTypeLabel("@cinatra-ai/blog-post-artifact:post")).toBe("Blog post");
    expect(reviewTypeLabel("@cinatra-ai/screenshot-artifact:artifact")).toBe("Screenshot");
    expect(reviewTypeLabel("@cinatra-ai/slide-deck-artifact:artifact")).toBe("Slide deck");
    expect(reviewTypeLabel("@cinatra-ai/brand-voice-artifact:artifact")).toBe("Brand voice");
  });

  it("reads in sentence case, never Title Case", () => {
    expect(reviewTypeLabel("@cinatra-ai/blog:post")).toBe("Blog");
    expect(reviewTypeLabel("@cinatra-ai/cms-content-snapshot:page")).toBe("Cms content snapshot");
    expect(reviewTypeLabel("@cinatra-ai/blog-post-artifact:post")).not.toContain("Post");
  });

  it("keeps saying something for a type that is only its packaging noun", () => {
    expect(reviewTypeLabel("@cinatra-ai/artifact:artifact")).toBe("Artifact");
  });
});

describe("the identity line", () => {
  it("draws its values bare — no labelled prefixes", () => {
    const facts = reviewTargetRowFacts(
      {
        ownerLevel: "Team",
        visibility: "Private",
        mime: "text/markdown",
        updatedAt: new Date("2026-09-02T10:00:00Z").toISOString(),
      },
      new Date("2026-09-02T10:08:00Z"),
    );
    expect(facts.join(" · ")).toBe("Team · Private · text/markdown · updated 8 min ago");
    for (const fact of facts) {
      expect(fact).not.toMatch(/^Ownership:/);
      expect(fact).not.toMatch(/^Visibility:/);
    }
  });

  it("reads the updated time as a person would, never a machine timestamp", () => {
    const facts = reviewTargetRowFacts(
      {
        ownerLevel: "Team",
        visibility: "Private",
        mime: "text/markdown",
        updatedAt: new Date("2026-09-02T10:00:00Z").toISOString(),
      },
      new Date("2026-09-02T10:08:00Z"),
    );
    expect(facts.at(-1)).toBe("updated 8 min ago");
    expect(facts.join(" ")).not.toContain("2026-09-02T");
  });
});

describe("the settled marker's sentence", () => {
  it("is the one the drawing draws for a continued gate", () => {
    expect(reviewSettledCopy("approved")).toEqual({
      title: "Continued",
      body: "Decided on the revision above. These are the words that will be sent.",
    });
  });
});
