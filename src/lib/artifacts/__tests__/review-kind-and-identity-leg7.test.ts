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

import { artifactKindLabelFor, resolveArtifactKindLabel } from "../artifact-kind-label";
import { reviewTargetRowFacts, reviewSettledCopy } from "../review-surface-model";

describe("the kind pill", () => {
  // THE PILL READS THE PACK'S OWN DECLARED KIND (the forward merge onto main,
  // 2026-09-11). This leg was written against a local derivation in the review
  // surface model, `reviewTypeLabel`. Main deleted that derivation -- it was the
  // third host copy of the same string surgery -- and the pill now reads the ONE
  // declared-first label, `artifactKindLabelFor`, which the artifact page header
  // and the library already read, so a pack cannot be named two ways.
  //
  // The leg's own assertion survives as its subject: the pill names the KIND,
  // never the type id, and never the packaging noun. Under the core/extension
  // border the SPELLING of that name is the pack's, declared in the pack's own
  // repository -- so the case of a declared label is not asserted here, and a
  // pack that declares nothing is the only one the host floors.
  it("names the kind from the pack's own declaration, never the type id", () => {
    expect(artifactKindLabelFor("@cinatra-ai/blog-post-artifact:post")).toBe("Blog Post");
    expect(artifactKindLabelFor("@cinatra-ai/screenshot-artifact:artifact")).toBe("Screenshot");
    expect(artifactKindLabelFor("@cinatra-ai/slide-deck-artifact:artifact")).toBe("Slide Deck");
    expect(artifactKindLabelFor("@cinatra-ai/brand-voice-artifact:artifact")).toBe("Brand Voice");
  });

  it("drops the packaging noun, because the pack's declaration carries none", () => {
    for (const id of [
      "@cinatra-ai/blog-post-artifact:post",
      "@cinatra-ai/screenshot-artifact:artifact",
      "@cinatra-ai/slide-deck-artifact:artifact",
      "@cinatra-ai/brand-voice-artifact:artifact",
    ]) {
      const resolved = resolveArtifactKindLabel(id);
      expect(resolved.source).toBe("declared");
      expect(resolved.label.toLowerCase()).not.toContain("artifact");
    }
  });

  it("keeps saying something for a pack that has declared nothing", () => {
    const resolved = resolveArtifactKindLabel("@acme/support-desk:case");
    expect(resolved.source).toBe("floor");
    expect(resolved.label).toBe("Support Desk");
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
