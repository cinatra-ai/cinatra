import { describe, expect, it } from "vitest";
import {
  ARTIFACT_KIND_LABEL_MAX_LENGTH,
  artifactKindLabelIssues,
  isDeclaredArtifactKindLabel,
} from "../artifact-contract";

// The declared artifact-kind label is `cinatra.displayName` — the field the
// pack ALREADY owns on its own manifest. This suite pins the SHAPE RULE the SDK
// states for that field when it is read as a kind label: short, one line, and
// not ending in the packaging word, so the label reads as the KIND of thing an
// artifact is ("Archive"), never as the name of the package that ships it
// ("Zip Artifact").
//
// The rule is ADVISORY at the SDK/host boundary, exactly like `vendor`: the
// pack owns its own spelling, so a declared label is carried THROUGH unchanged
// apart from trimmed surrounding whitespace, and this function only NAMES the
// gap for the companion repo's own publish / conformance gate. The host never
// overrules a declaration — which is why a shipped label that trips this rule
// keeps rendering as declared until its own repository changes it.

describe("artifactKindLabelIssues — the declared kind label's shape rule", () => {
  it("accepts the labels the shipped artifact fleet declares today", () => {
    for (const label of [
      "PDF",
      "Document",
      "Archive",
      "JSON",
      "Text",
      "Markdown",
      "Screenshot",
      "Slide Deck",
      "Image",
      "Blog Post",
      "Blog Idea",
      "Dashboard",
      "CMS Snapshot",
      "Episode",
    ]) {
      expect(artifactKindLabelIssues(label), label).toEqual([]);
      expect(isDeclaredArtifactKindLabel(label), label).toBe(true);
    }
  });

  it("names a label that ends in the packaging word — the kind is not the package", () => {
    expect(artifactKindLabelIssues("Zip Artifact")).toEqual(["trailing-packaging-word"]);
    expect(artifactKindLabelIssues("LinkedIn Artifacts")).toEqual(["trailing-packaging-word"]);
    expect(artifactKindLabelIssues("Email artifacts")).toEqual(["trailing-packaging-word"]);
    expect(isDeclaredArtifactKindLabel("Drupal Artifacts")).toBe(false);
  });

  it("does not flag a label that merely CONTAINS the packaging stem inside a word", () => {
    expect(artifactKindLabelIssues("Artifactory export")).toEqual([]);
  });

  it("names a BARE packaging word — a label of nothing but the container word", () => {
    // The container word alone says nothing about the kind, so the rule holds
    // whether that word stands alone or ends a phrase.
    expect(artifactKindLabelIssues("Artifact")).toEqual(["trailing-packaging-word"]);
    expect(artifactKindLabelIssues("Artifacts")).toEqual(["trailing-packaging-word"]);
    expect(isDeclaredArtifactKindLabel("artifacts")).toBe(false);
  });

  it("names EVERY issue that applies, not merely the first one found", () => {
    const overlong = `${"Long ".repeat(8)}Artifacts`;
    expect(overlong.length).toBeGreaterThan(ARTIFACT_KIND_LABEL_MAX_LENGTH);
    expect(artifactKindLabelIssues(overlong)).toEqual(["too-long", "trailing-packaging-word"]);
  });

  it("names an absent, blank, over-long or multi-line declaration", () => {
    expect(artifactKindLabelIssues(undefined)).toEqual(["not-a-string"]);
    expect(artifactKindLabelIssues(42)).toEqual(["not-a-string"]);
    expect(artifactKindLabelIssues("   ")).toEqual(["empty"]);
    expect(artifactKindLabelIssues("x".repeat(ARTIFACT_KIND_LABEL_MAX_LENGTH + 1))).toEqual([
      "too-long",
    ]);
    expect(artifactKindLabelIssues("Slide\nDeck")).toEqual(["multi-line"]);
  });

  it("the maximum is a short label, not a sentence", () => {
    expect(ARTIFACT_KIND_LABEL_MAX_LENGTH).toBe(32);
  });
});
