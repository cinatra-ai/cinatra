import { describe, it, expect, vi } from "vitest";

// server-only is a runtime marker with no test value; stub it.
vi.mock("server-only", () => ({}));

// Isolate the module from its heavy @/ + external-MCP graph. None of it is
// exercised by the pure projection helpers.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: [],
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(),
  sanitizeExternalMcpToolboxTools: vi.fn(),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildSingleExternalMcpTool: vi.fn(),
}));
vi.mock("@/lib/llm-toolbox-providers", () => ({
  buildAllToolboxProviderTools: vi.fn(),
}));
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getPublicMcpServerUrl: () => "https://mcp.example.test/api/mcp",
  getLlmMcpCredentials: () => null,
  getLocalTokenEndpointUrl: () => "https://local.example.test/api/auth/token",
  getLocalMcpServerUrl: () => "https://local.example.test/api/mcp",
  hasLlmMcpAccess: () => true,
  getLlmMcpAccessStatus: () => "ok",
}));

// The canonical cacheable-prefix projection.
//
// Prompt caching is a prefix match, so the only meaningful question about
// prefix stability is a question about bytes: reduce two turns to the content
// that is SUPPOSED to be stable and compare. These cases pin the reduction's
// three load-bearing properties: it excludes credential material, it absorbs
// tool-ordering noise, and it is sensitive to a real prefix change, plus the
// one property that is a finding rather than a guarantee: a per-turn bearer
// token is invisible to the projection while still being present on the wire.

import {
  projectCacheablePrefix,
  serializeCacheablePrefixProjection,
} from "../mcp-access";
import type { LlmTool } from "../types";

const mcpTool = (overrides: Partial<Extract<LlmTool, { type: "mcp" }>> = {}) =>
  ({
    type: "mcp",
    serverLabel: "cinatra",
    serverUrl: "https://mcp.example.test/api/mcp",
    headers: { Authorization: "Bearer turn-1-token" },
    allowedTools: ["agent_list", "agent_get"],
    approval: "auto_execute",
    transport: "streamable-http",
    ...overrides,
  }) as LlmTool;

describe("projectCacheablePrefix: excludes credential material", () => {
  it("never carries a bearer token into the projection", () => {
    const projected = projectCacheablePrefix({
      system: "You are Cinatra.",
      tools: [mcpTool()],
    });
    const serialized = serializeCacheablePrefixProjection(projected);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("turn-1-token");
    expect(serialized).not.toContain("Authorization");
  });

  it("projects two turns identically when only the minted token differs", () => {
    // This is the FINDING, pinned as behavior: the chat tool block carries a
    // freshly minted, wall-clock-stamped token on every turn. The projection
    // is blind to it by design, which is exactly why a stable projection must
    // never be read as evidence of a cache hit.
    const turn1 = projectCacheablePrefix({
      system: "You are Cinatra.",
      tools: [mcpTool({ headers: { Authorization: "Bearer turn-1-token" } })],
    });
    const turn2 = projectCacheablePrefix({
      system: "You are Cinatra.",
      tools: [mcpTool({ headers: { Authorization: "Bearer turn-2-token" } })],
    });
    expect(turn1).toEqual(turn2);
  });
});

describe("projectCacheablePrefix: absorbs ordering noise", () => {
  it("is insensitive to tool registration order", () => {
    const a = projectCacheablePrefix({
      system: "s",
      tools: [mcpTool(), { type: "web_search" } as LlmTool],
    });
    const b = projectCacheablePrefix({
      system: "s",
      tools: [{ type: "web_search" } as LlmTool, mcpTool()],
    });
    expect(a).toEqual(b);
  });

  it("is insensitive to allowlist order but sensitive to allowlist membership", () => {
    const ordered = projectCacheablePrefix({
      tools: [mcpTool({ allowedTools: ["agent_get", "agent_list"] })],
    });
    const reversed = projectCacheablePrefix({
      tools: [mcpTool({ allowedTools: ["agent_list", "agent_get"] })],
    });
    expect(ordered).toEqual(reversed);

    const widened = projectCacheablePrefix({
      tools: [mcpTool({ allowedTools: ["agent_list", "agent_get", "objects_list"] })],
    });
    expect(widened).not.toEqual(ordered);
  });

  it("distinguishes an unrestricted reference from a narrowed one", () => {
    const unrestricted = projectCacheablePrefix({ tools: [mcpTool({ allowedTools: null })] });
    const narrowed = projectCacheablePrefix({ tools: [mcpTool()] });
    expect(unrestricted).not.toEqual(narrowed);
    expect(serializeCacheablePrefixProjection(unrestricted)).toContain("allowed=*");
  });
});

describe("projectCacheablePrefix: sensitive to real prefix change", () => {
  it("changes when the system text changes by one byte", () => {
    const a = projectCacheablePrefix({ system: "You are Cinatra." });
    const b = projectCacheablePrefix({ system: "You are Cinatra!" });
    expect(a).not.toEqual(b);
  });

  it("changes when the MCP server the reference points at changes", () => {
    const a = projectCacheablePrefix({ tools: [mcpTool()] });
    const b = projectCacheablePrefix({
      tools: [mcpTool({ serverUrl: "https://other.example.test/api/mcp" })],
    });
    expect(a).not.toEqual(b);
  });

  it("is total, so an empty turn projects without throwing", () => {
    expect(projectCacheablePrefix({})).toEqual({ system: "", tools: [] });
  });
});
