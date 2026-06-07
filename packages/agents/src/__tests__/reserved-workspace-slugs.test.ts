import { describe, it, expect } from "vitest";
import {
  RESERVED_WORKSPACE_PACKAGE_SLUGS,
  isReservedWorkspaceSlug,
  assertNotReservedAgentPackageName,
} from "../reserved-workspace-slugs";

describe("reserved-workspace-slugs", () => {
  it("flags @cinatra-ai/<workspace-slug> as reserved", () => {
    expect(isReservedWorkspaceSlug("@cinatra-ai/agents")).toBe(true);
    expect(isReservedWorkspaceSlug("@cinatra-ai/skills")).toBe(true);
    expect(isReservedWorkspaceSlug("@cinatra-ai/trigger")).toBe(true);
    expect(isReservedWorkspaceSlug("@cinatra-ai/chat")).toBe(true);
    expect(isReservedWorkspaceSlug("@cinatra-ai/gmail-connector")).toBe(true);
  });

  it("does NOT flag genuine agent slugs", () => {
    expect(isReservedWorkspaceSlug("@cinatra-ai/web-scrape-agent")).toBe(false);
    expect(isReservedWorkspaceSlug("@cinatra-ai/trigger-agent")).toBe(false);
    expect(isReservedWorkspaceSlug("@cinatra-ai/email-test-delivery-agent")).toBe(false);
    expect(isReservedWorkspaceSlug("@cinatra-ai/auditor-agent")).toBe(
      false,
    );
  });

  it("only bites the canonical @cinatra-ai scope (operator-vendor scopes have no collision)", () => {
    expect(isReservedWorkspaceSlug("@acme/skills")).toBe(false);
    expect(isReservedWorkspaceSlug("@cinatra/skills")).toBe(false);
    expect(isReservedWorkspaceSlug("skills")).toBe(false);
    expect(isReservedWorkspaceSlug("@cinatra-ai/skills/extra")).toBe(false);
    expect(isReservedWorkspaceSlug("@cinatra-ai/Skills")).toBe(false);
  });

  it("assertNotReservedAgentPackageName throws on collision, passes otherwise", () => {
    expect(() =>
      assertNotReservedAgentPackageName("@cinatra-ai/objects"),
    ).toThrow(/reserved workspace/i);
    expect(() =>
      assertNotReservedAgentPackageName("@cinatra-ai/my-cool-agent"),
    ).not.toThrow();
    expect(() =>
      assertNotReservedAgentPackageName("@acme/objects"),
    ).not.toThrow();
  });

  it("the reserved set covers the known workspace packages", () => {
    for (const slug of [
      "agents",
      "skills",
      "chat",
      "objects",
      "registries",
      "llm",
      "mcp-server",
      "trigger",
      "a2a",
    ]) {
      expect(RESERVED_WORKSPACE_PACKAGE_SLUGS.has(slug)).toBe(true);
    }
  });
});
