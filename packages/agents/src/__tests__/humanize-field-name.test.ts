/**
 * Unit tests for humanizeFieldName — the fallback label humanizer used by
 * setup/HITL field renderers when a schema `title` is absent (issue #815).
 *
 * Pure-logic tests. No DB, no React, no server-only.
 */
import { describe, it, expect } from "vitest";
import { humanizeFieldName } from "../humanize-field-name";

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
