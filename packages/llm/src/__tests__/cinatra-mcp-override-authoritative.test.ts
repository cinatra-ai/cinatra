/**
 * #1195 (codex round-1) — the cinatraMcpToolOverride null contract.
 *
 * A present override OWNS cinatra self-MCP resolution INCLUDING the machine
 * `client_credentials` fallback: the bridge mints the machine token itself so
 * the durable run-context binding is keyed to the EXACT bearer attached to
 * the tool. The registry layer must treat a null override result as
 * AUTHORITATIVE — re-minting here would attach a bearer with NO durable
 * binding (reintroducing the process-local registry's cross-run aliasing
 * risk for exactly the transient-failure mints the binding exists to cover)
 * and double the token-endpoint load.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const { buildLlmMcpServerToolMock } = vi.hoisted(() => ({
  buildLlmMcpServerToolMock: vi.fn(
    async (): Promise<Record<string, unknown> | null> => ({
      type: "mcp",
      serverLabel: "cinatra",
      serverUrl: "http://localhost:3000/api/mcp",
      headers: { Authorization: "Bearer registry-machine-token" },
    }),
  ),
}));

vi.mock("../mcp-access", () => ({
  buildLlmMcpServerTool: buildLlmMcpServerToolMock,
  buildExternalMcpServerTools: vi.fn(async () => []),
}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: vi.fn(() => null),
  getLlmProviderSurface: vi.fn(() => null),
  requireLlmProviderSurface: vi.fn(() => null),
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
vi.mock("@/lib/external-mcp-toolbox-loader.server", () => ({
  loadExternalMcpToolboxBySlug: vi.fn(async () => null),
  sanitizeExternalMcpToolboxTools: vi.fn((tools: unknown) => tools),
}));
vi.mock("@/lib/llm-toolbox-providers", () => ({
  buildToolboxProviderTools: vi.fn(async () => null),
}));

import { resolveMcpToolsForDeclaredIds } from "../registry";

const OVERRIDE_TOOL = {
  type: "mcp",
  serverLabel: "cinatra",
  serverUrl: "http://localhost:3000/api/mcp",
  headers: { Authorization: "Bearer bridge-bound-token" },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("cinatraMcpToolOverride null is authoritative (#1195)", () => {
  it("override returns a tool → used verbatim, no registry-layer mint", async () => {
    const tools = await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: ["cinatra-mcp"],
      cinatraMcpToolOverride: async () => OVERRIDE_TOOL,
    });
    expect(tools).toEqual([OVERRIDE_TOOL]);
    expect(buildLlmMcpServerToolMock).not.toHaveBeenCalled();
  });

  it("override returns null → NO second machine mint (an unbound bearer would ride the legacy registry)", async () => {
    const tools = await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: ["cinatra-mcp"],
      cinatraMcpToolOverride: async () => null,
    });
    expect(tools).toEqual([]);
    expect(buildLlmMcpServerToolMock).not.toHaveBeenCalled();
  });

  it("no override at all → the legacy machine mint path is preserved", async () => {
    const tools = await resolveMcpToolsForDeclaredIds({
      provider: "openai",
      declaredToolboxIds: ["cinatra-mcp"],
    });
    expect(buildLlmMcpServerToolMock).toHaveBeenCalledWith("openai");
    expect(tools).toHaveLength(1);
  });
});
