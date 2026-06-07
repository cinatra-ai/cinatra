// Verifies the first-party Apify MCP tool builder.
// Mirrors the test shape of Drupal/WordPress builder tests.

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@cinatra-ai/apify-connector", () => ({
  getApifySettings: vi.fn(),
}));

vi.mock("@cinatra-ai/nango-connector", () => ({
  buildBearerAuthHeaderFromNango: vi.fn(),
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS: { apify: "cinatra-apify" },
  isNangoConfigured: vi.fn(),
}));

import { getApifySettings } from "@cinatra-ai/apify-connector";
import { buildBearerAuthHeaderFromNango, isNangoConfigured } from "@cinatra-ai/nango-connector";
import { buildApifyMcpServerTools } from "@/lib/apify-mcp-connection";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildApifyMcpServerTools — first-party builder", () => {
  it("returns [] when Nango is not configured + no connection saved (no warn)", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    vi.mocked(getApifySettings).mockReturnValue({} as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toEqual([]);
    // Settings are read first to decide whether a loud warn is warranted;
    // with no saved connection there's nothing to warn about.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] AND warns loudly when Nango is unconfigured but a connection was saved (fail-closed loud)", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    vi.mocked(getApifySettings).mockReturnValue({
      lastValidatedAt: "x",
      username: "u",
      nangoConnectionId: "cinatra-apify",
    } as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("apify");
    expect(msg).not.toContain("cinatra-apify"); // label only, no connection id leak beyond the connector name
    warn.mockRestore();
  });

  it("returns [] when no nangoConnectionId is set on the connector_config row (never connected)", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(true);
    vi.mocked(getApifySettings).mockReturnValue({ lastValidatedAt: "x", username: "u" } as never);

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toEqual([]);
    expect(vi.mocked(buildBearerAuthHeaderFromNango)).not.toHaveBeenCalled();
  });

  it("returns [] when Nango header resolution returns null (helper warns label, no token)", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(true);
    vi.mocked(getApifySettings).mockReturnValue({
      lastValidatedAt: "x",
      username: "u",
      nangoConnectionId: "cinatra-apify",
    } as never);
    vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValueOnce(null);

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toEqual([]);
    expect(vi.mocked(buildBearerAuthHeaderFromNango)).toHaveBeenCalledWith({
      providerConfigKey: "cinatra-apify",
      connectionId: "cinatra-apify",
      label: "apify",
    });
  });

  it("returns the LlmMcpServerTool with the resolved Authorization header when Nango resolves", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(true);
    vi.mocked(getApifySettings).mockReturnValue({
      lastValidatedAt: "x",
      username: "u",
      nangoConnectionId: "cinatra-apify",
    } as never);
    vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValueOnce({ Authorization: "Bearer secret-token-abc" });

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "mcp",
      serverLabel: "apify-connector",
      serverUrl: "https://mcp.apify.com",
      headers: { Authorization: "Bearer secret-token-abc" },
      serverDescription: "Apify MCP — actor tools",
      allowedTools: null,
      requireApproval: "never",
    });
  });

  it("returns [] and never throws when getApifySettings throws", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(true);
    vi.mocked(getApifySettings).mockImplementation(() => {
      throw new Error("DB unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildApifyMcpServerTools("openai");

    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
