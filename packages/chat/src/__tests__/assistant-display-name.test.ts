import { describe, expect, it } from "vitest";

import { resolveAssistantDisplayName } from "../assistant-display-name";

describe("resolveAssistantDisplayName", () => {
  it("maps the canonical 'cinatra' handle to branded 'Cinatra'", () => {
    expect(resolveAssistantDisplayName("cinatra")).toBe("Cinatra");
  });

  it("falls back to 'Assistant' for null/undefined/empty", () => {
    expect(resolveAssistantDisplayName(null)).toBe("Assistant");
    expect(resolveAssistantDisplayName(undefined)).toBe("Assistant");
    expect(resolveAssistantDisplayName("")).toBe("Assistant");
  });

  it("leaves every other handle untouched (verbatim case)", () => {
    expect(resolveAssistantDisplayName("my-agent")).toBe("my-agent");
    expect(resolveAssistantDisplayName("claude")).toBe("claude");
    expect(resolveAssistantDisplayName("OpenAI")).toBe("OpenAI");
    // Only the exact canonical lowercase handle maps — other casings of
    // "cinatra" are NOT the canonical handle and render verbatim.
    expect(resolveAssistantDisplayName("Cinatra")).toBe("Cinatra");
    expect(resolveAssistantDisplayName("CINATRA")).toBe("CINATRA");
    expect(resolveAssistantDisplayName("cinatra-research")).toBe("cinatra-research");
  });
});
