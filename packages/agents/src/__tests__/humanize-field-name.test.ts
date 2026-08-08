/**
 * Unit tests for humanizeFieldName — the fallback label humanizer used by
 * setup/HITL field renderers when a schema `title` is absent (issue #815).
 *
 * Pure-logic tests. No DB, no React, no server-only.
 */
import { describe, it, expect } from "vitest";
import {
  GENERIC_FIELD_LABEL,
  HITL_PLACEHOLDER_FIELD_NAME,
  humanizeFieldName,
  isInternalPlaceholderFieldName,
  resolveFieldLabel,
} from "../humanize-field-name";

describe("humanizeFieldName", () => {
  it("splits camelCase into title case", () => {
    expect(humanizeFieldName("postTitle")).toBe("Post Title");
  });

  it("uppercases trailing acronyms", () => {
    expect(humanizeFieldName("blogPostUrl")).toBe("Blog Post URL");
  });

  it("uppercases mid-word acronyms like JSON", () => {
    expect(humanizeFieldName("selectedIdeaJson")).toBe("Selected Idea JSON");
  });

  it("uppercases a bare acronym key", () => {
    expect(humanizeFieldName("id")).toBe("ID");
  });

  it("splits snake_case and uppercases acronyms", () => {
    expect(humanizeFieldName("api_key")).toBe("API Key");
  });

  it("capitalizes a simple single word", () => {
    expect(humanizeFieldName("simple")).toBe("Simple");
  });

  it("splits leading uppercase acronym runs", () => {
    expect(humanizeFieldName("HTTPServer")).toBe("HTTP Server");
  });
});

describe("resolveFieldLabel", () => {
  it("uses a meaningful title verbatim", () => {
    expect(resolveFieldLabel("companyUrl", "Company Website")).toBe(
      "Company Website"
    );
  });

  it("humanizes when the title is the raw field key (title === fieldName)", () => {
    // The bug: OAS compilers emit title === key, so the humanizer was bypassed.
    expect(resolveFieldLabel("companyUrl", "companyUrl")).toBe("Company URL");
    expect(resolveFieldLabel("referenceContent", "referenceContent")).toBe(
      "Reference Content"
    );
    expect(resolveFieldLabel("imageCount", "imageCount")).toBe("Image Count");
    expect(resolveFieldLabel("linkedinPost", "linkedinPost")).toBe(
      "Linkedin Post"
    );
  });

  it("humanizes a bare lowercase key whose title equals it", () => {
    expect(resolveFieldLabel("brief", "brief")).toBe("Brief");
    expect(resolveFieldLabel("tone", "tone")).toBe("Tone");
  });

  it("humanizes when there is no title", () => {
    expect(resolveFieldLabel("blogPostUrl")).toBe("Blog Post URL");
  });

  it("treats an empty or whitespace title as absent", () => {
    expect(resolveFieldLabel("imageCount", "")).toBe("Image Count");
    expect(resolveFieldLabel("imageCount", "   ")).toBe("Image Count");
  });

  it("falls back to a description only when the title is absent or the key", () => {
    expect(resolveFieldLabel("companyUrl", undefined, "The company website")).toBe(
      "The company website"
    );
    expect(resolveFieldLabel("companyUrl", "companyUrl", "The company website")).toBe(
      "The company website"
    );
  });

  it("prefers a meaningful title over a description", () => {
    expect(
      resolveFieldLabel("companyUrl", "Company Website", "The company website")
    ).toBe("Company Website");
  });
});

/**
 * cinatra#2541 — the internal `hitl-field` wiring token must never be humanized
 * into a user-facing label. It is a renderer-plumbing placeholder (a DOM id and
 * a registry key), not a field name, and humanizing it produced the nonsense
 * "Hitl Field" label the issue reports.
 *
 * This is the LAST line of defence, not the fix: the panels now pass the
 * interrupt's real field name (see hitl-gate-submit.hitlRendererFieldName and
 * orchestrator-stepper-hitl-field-label.test.tsx). This guard covers the
 * surfaces that genuinely have no field identity to pass.
 */
describe("resolveFieldLabel — internal placeholder guard (cinatra#2541)", () => {
  it("recognizes the HITL wiring token as an internal placeholder", () => {
    expect(isInternalPlaceholderFieldName(HITL_PLACEHOLDER_FIELD_NAME)).toBe(true);
    expect(isInternalPlaceholderFieldName("Hitl-Field")).toBe(true);
    expect(isInternalPlaceholderFieldName("  hitl-field ")).toBe(true);
    // A real field that merely resembles it is NOT a placeholder.
    expect(isInternalPlaceholderFieldName("hitlFieldNotes")).toBe(false);
    expect(isInternalPlaceholderFieldName("idea")).toBe(false);
  });

  it("never humanizes the placeholder into 'Hitl Field'", () => {
    const label = resolveFieldLabel(HITL_PLACEHOLDER_FIELD_NAME);
    expect(label).toBe(GENERIC_FIELD_LABEL);
    expect(label).not.toBe("Hitl Field");
    expect(humanizeFieldName(HITL_PLACEHOLDER_FIELD_NAME)).toBe("Hitl Field");
  });

  it("still prefers a real schema title over the neutral label", () => {
    expect(resolveFieldLabel(HITL_PLACEHOLDER_FIELD_NAME, "Blog idea")).toBe(
      "Blog idea"
    );
  });

  it("still prefers a description over the neutral label", () => {
    expect(
      resolveFieldLabel(HITL_PLACEHOLDER_FIELD_NAME, undefined, "What should we write about?")
    ).toBe("What should we write about?");
  });

  it("treats a title that IS the placeholder token as absent", () => {
    expect(resolveFieldLabel("idea", HITL_PLACEHOLDER_FIELD_NAME)).toBe("Idea");
    expect(
      resolveFieldLabel(HITL_PLACEHOLDER_FIELD_NAME, HITL_PLACEHOLDER_FIELD_NAME)
    ).toBe(GENERIC_FIELD_LABEL);
  });

  it("leaves every real field name humanized exactly as before", () => {
    expect(resolveFieldLabel("idea")).toBe("Idea");
    expect(resolveFieldLabel("blogPostUrl")).toBe("Blog Post URL");
    expect(resolveFieldLabel("referenceContent", "referenceContent")).toBe(
      "Reference Content"
    );
  });
});
