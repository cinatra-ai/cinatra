/**
 * Unit tests for humanizeFieldName — the fallback label humanizer used by
 * setup/HITL field renderers when a schema `title` is absent (issue #815).
 *
 * Pure-logic tests. No DB, no React, no server-only.
 */
import { describe, it, expect } from "vitest";
import { humanizeFieldName, resolveFieldLabel } from "../humanize-field-name";

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
