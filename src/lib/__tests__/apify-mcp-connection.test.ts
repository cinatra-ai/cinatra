// Verifies the transitional Apify shim: buildApifyMcpServerTools resolves the
// first-party Apify toolbox through the generated manifest loader (no named
// extension import) and preserves the never-throw / empty-on-failure contract
// the declared-toolbox-id path in packages/llm/src/registry.ts relies on.
// The builder's own behavior is tested in the apify-connector extension
// (src/__tests__/toolbox.test.ts).

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/external-mcp-toolbox-loader.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/external-mcp-toolbox-loader.server")>();
  return {
    // Keep the REAL sanitizer so the shim's malformed-output handling is
    // exercised; only the loader resolution is stubbed.
    sanitizeExternalMcpToolboxTools: actual.sanitizeExternalMcpToolboxTools,
    loadExternalMcpToolboxBySlug: vi.fn(),
  };
});

import { loadExternalMcpToolboxBySlug } from "@/lib/external-mcp-toolbox-loader.server";
import { buildApifyMcpServerTools } from "@/lib/apify-mcp-connection";

const apifyTool = {
  type: "mcp" as const,
  serverLabel: "apify-connector",
  serverUrl: "https://mcp.apify.com",
  headers: { Authorization: "Bearer secret-token-abc" },
  serverDescription: "Apify MCP — actor tools",
  allowedTools: null,
  requireApproval: "never" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildApifyMcpServerTools — manifest-loader shim", () => {
  it("resolves the apify-connector slug through the generated toolbox loader", async () => {
    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce({
      buildTools: vi.fn(async () => [apifyTool]),
    });

    const result = await buildApifyMcpServerTools("openai");

    expect(vi.mocked(loadExternalMcpToolboxBySlug)).toHaveBeenCalledWith("apify-connector");
    expect(result).toEqual([apifyTool]);
  });

  it("returns [] and warns when no generated toolbox entry exists", async () => {
    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] and never throws when the loader throws", async () => {
    vi.mocked(loadExternalMcpToolboxBySlug).mockRejectedValueOnce(new Error("bad factory"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] and never throws when buildTools throws", async () => {
    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce({
      buildTools: vi.fn(async () => {
        throw new Error("nango exploded");
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("sanitizes malformed builder output: non-array → [], invalid entries dropped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce({
      buildTools: vi.fn(async () => null as never),
    });
    expect(await buildApifyMcpServerTools("openai")).toEqual([]);

    vi.mocked(loadExternalMcpToolboxBySlug).mockResolvedValueOnce({
      buildTools: vi.fn(async () => [apifyTool, { bogus: true } as never]),
    });
    expect(await buildApifyMcpServerTools("openai")).toEqual([apifyTool]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
