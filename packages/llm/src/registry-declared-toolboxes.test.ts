/**
 * Declared-toolbox-id resolution + duplicate-label collapse contract for the
 * manifest-driven external-MCP toolbox cutover.
 *
 * - A declared id matching a generated first-party toolbox slug resolves
 *   through the extension's own builder (no host edit per extension).
 * - A declared id served by a registered `llm-toolbox` capability provider
 *   (apify today, via its serverEntry) resolves through that provider —
 *   BEFORE the manifest-toolbox branch (registration-driven wins).
 * - Unknown ids still fall through to the external_mcp_servers resolver.
 * - The always-inject path and the chat path collapse duplicate server labels
 *   (a marker extension's registry row can be resolved by BOTH the manifest
 *   path and the registry-wide global injection).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LlmMcpServerTool } from "./types";

// ---------------------------------------------------------------------------
// Mocks — registered BEFORE the module-under-test is imported
// ---------------------------------------------------------------------------

vi.mock("./providers/openai", () => ({
  createOpenAIProviderAdapter: vi.fn(),
  getConfiguredOpenAIConnection: vi.fn(async () => null),
}));
vi.mock("./providers/anthropic", () => ({
  createAnthropicProviderAdapter: vi.fn(),
}));
vi.mock("./providers/gemini", () => ({
  createGeminiProviderAdapter: vi.fn(),
  getConfiguredGeminiConnection: vi.fn(async () => null),
}));
vi.mock("./mcp-access", () => ({
  buildLlmMcpServerTool: vi.fn(async () => null),
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
// LLM provider surfaces resolve to "absent" — the registry's anthropic
// connection degrades to null (cinatra#151 Stage 2; same semantics as the
// pre-cutover connector mock).
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn((providerId: string) => {
    throw new Error(`The "${providerId}" LLM provider connector is not installed/active`);
  }),
  listLlmProviderSurfaces: vi.fn(() => []),
}));
vi.mock("@/lib/database", () => ({
  readDefaultLlmProviderFromDatabase: vi.fn(() => "openai"),
  readDefaultImageProviderFromDatabase: vi.fn(() => null),
}));
vi.mock("@/lib/external-mcp-registry", () => ({
  buildRegisteredExternalMcpServerTools: vi.fn(async () => []),
  buildSingleExternalMcpTool: vi.fn(async () => null),
}));
vi.mock("@/lib/external-mcp-toolbox-loader.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/external-mcp-toolbox-loader.server")>();
  return {
    // Keep the REAL sanitizer so the declared-id path's malformed-output
    // handling is exercised; only the loader resolution is stubbed.
    sanitizeExternalMcpToolboxTools: actual.sanitizeExternalMcpToolboxTools,
    loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  };
});
vi.mock("@/lib/llm-toolbox-providers", () => ({
  // Default: no capability provider serves the id — fall through to the
  // manifest-toolbox branch / registry resolver.
  buildToolboxProviderTools: vi.fn(async () => null),
}));

import {
  buildRegisteredExternalMcpServerTools,
  buildSingleExternalMcpTool,
} from "@/lib/external-mcp-registry";
import { loadExternalMcpToolboxBySlug } from "@/lib/external-mcp-toolbox-loader.server";
import { buildToolboxProviderTools } from "@/lib/llm-toolbox-providers";
import { buildExternalMcpServerTools } from "./mcp-access";
import { resolveMcpToolsForDeclaredIds, resolveChatExternalMcpTools } from "./registry";

const tool = (serverLabel: string, serverUrl = `https://${serverLabel}.example.com/mcp`): LlmMcpServerTool => ({
  type: "mcp",
  serverLabel,
  serverUrl,
  serverDescription: serverLabel,
  allowedTools: null,
  requireApproval: "never",
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveMcpToolsForDeclaredIds — declared ids", () => {
  it("resolves a declared id with a generated toolbox entry through the extension builder", async () => {
    const wpTool = tool("wordpress-1");
    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce({
      buildTools: vi.fn(async () => [wpTool]),
    });

    const tools = await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: ["wordpress-mcp-connector"],
    });

    expect(vi.mocked(loadExternalMcpToolboxBySlug)).toHaveBeenCalledWith("wordpress-mcp-connector");
    expect(tools).toEqual([wpTool]);
    expect(vi.mocked(buildSingleExternalMcpTool)).not.toHaveBeenCalled();
  });

  it("routes a declared id served by an llm-toolbox capability provider through that provider", async () => {
    const apifyTool = tool("apify-connector", "https://mcp.apify.com");
    vi.mocked(buildToolboxProviderTools).mockResolvedValueOnce([apifyTool]);

    const tools = await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: ["apify-connector"],
    });

    expect(vi.mocked(buildToolboxProviderTools)).toHaveBeenCalledWith("apify-connector", "openai");
    expect(tools).toEqual([apifyTool]);
    // The capability branch precedes the generic manifest-toolbox branch.
    expect(vi.mocked(loadExternalMcpToolboxBySlug)).not.toHaveBeenCalled();
  });

  it("falls through to the external_mcp_servers resolver for ids without a toolbox entry", async () => {
    const rowTool = tool("external-row-1");
    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce(null);
    vi.mocked(buildSingleExternalMcpTool).mockResolvedValueOnce(rowTool);

    const tools = await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: ["row-1"],
    });

    expect(vi.mocked(buildSingleExternalMcpTool)).toHaveBeenCalledWith("row-1");
    expect(tools).toEqual([rowTool]);
  });

  it("sanitizes malformed builder output on the declared-id path (invalid entries dropped, non-array → id dropped)", async () => {
    const wpTool = tool("wordpress-1");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce({
      buildTools: vi.fn(async () => [wpTool, { bogus: true } as never]),
    });
    expect(
      await resolveMcpToolsForDeclaredIds({
        provider: "openai",
        declaredToolboxIds: ["wordpress-mcp-connector"],
      }),
    ).toEqual([wpTool]);

    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce({
      buildTools: vi.fn(async () => null as never),
    });
    expect(
      await resolveMcpToolsForDeclaredIds({
        provider: "openai",
        declaredToolboxIds: ["wordpress-mcp-connector"],
      }),
    ).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drops a declared id (warn, no throw) when its toolbox loader fails", async () => {
    vi.mocked(loadExternalMcpToolboxBySlug).mockRejectedValueOnce(new Error("bad factory"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const tools = await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: ["broken-connector"],
    });

    expect(tools).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(vi.mocked(buildSingleExternalMcpTool)).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("duplicate server-label collapse (manifest path ∪ registry-wide injection)", () => {
  it("legacy always-inject path keeps one tool per server label", async () => {
    const viaMarker = tool("external-row-9");
    const viaRegistryWide = tool("external-row-9");
    vi.mocked(buildExternalMcpServerTools).mockResolvedValueOnce([viaMarker]);
    vi.mocked(buildRegisteredExternalMcpServerTools).mockResolvedValueOnce([viaRegistryWide]);

    const tools = await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: undefined,
    });

    expect(tools).toEqual([viaMarker]);
  });

  it("skipExternalMcpRegistry also suppresses the manifest path's registry fallback", async () => {
    await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: undefined,
      skipExternalMcpRegistry: true,
    });

    expect(vi.mocked(buildExternalMcpServerTools)).toHaveBeenCalledWith("openai", {
      skipRegistryFallback: true,
    });
    expect(vi.mocked(buildRegisteredExternalMcpServerTools)).not.toHaveBeenCalled();
  });

  it("chat external path keeps one tool per server label and preserves distinct labels", async () => {
    const a = tool("external-row-9");
    const b = tool("wordpress-1");
    vi.mocked(buildExternalMcpServerTools).mockResolvedValueOnce([b, a]);
    vi.mocked(buildRegisteredExternalMcpServerTools).mockResolvedValueOnce([tool("external-row-9")]);

    const tools = await resolveChatExternalMcpTools("openai");

    expect(tools).toEqual([b, a]);
  });
});
