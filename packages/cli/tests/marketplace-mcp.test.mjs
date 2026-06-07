// Tests for the CLI's marketplace MCP helper.
// SDK is mocked via vi.mock so we can assert wiring without a live server.

import { afterEach, describe, expect, it, vi } from "vitest";

const { connectMock, callToolMock, closeMock, transportCtor } = vi.hoisted(() => ({
  connectMock: vi.fn().mockResolvedValue(undefined),
  callToolMock: vi.fn(),
  closeMock: vi.fn().mockResolvedValue(undefined),
  transportCtor: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function () {
    this.connect = connectMock;
    this.callTool = callToolMock;
    this.close = closeMock;
  }),
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function (url, opts) {
    transportCtor(url, opts);
  }),
}));

const { callMarketplaceTool, resolveMarketplaceBaseUrl, MARKETPLACE_BASE_URL } =
  await import("../src/marketplace-mcp.mjs");

describe("callMarketplaceTool", () => {
  afterEach(() => {
    connectMock.mockClear();
    callToolMock.mockReset();
    closeMock.mockClear();
    transportCtor.mockClear();
    vi.unstubAllEnvs();
  });

  it("throws when MARKETPLACE_INSTANCE_TOKEN is not set", async () => {
    vi.stubEnv("MARKETPLACE_INSTANCE_TOKEN", "");
    await expect(
      callMarketplaceTool("extension_submit_for_review", {}, { baseUrl: "https://mk.test" }),
    ).rejects.toThrow(/MARKETPLACE_INSTANCE_TOKEN is not set/);
  });

  it("targets the MCP endpoint and uses cinatra-<kebab> tool naming", async () => {
    callToolMock.mockResolvedValue({ structuredContent: { ok: true } });
    await callMarketplaceTool(
      "extension_submit_for_review",
      { namespace: "@acme" },
      { baseUrl: "https://mk.test", token: "tok-123" },
    );
    const [url] = transportCtor.mock.calls[0];
    expect(url.toString()).toBe("https://mk.test/wp-json/cinatra/mcp");
    expect(callToolMock).toHaveBeenCalledWith({
      name: "cinatra-extension-submit-for-review",
      arguments: { namespace: "@acme" },
    });
  });

  it("sends a raw token as Bearer and passes a schemed token through unchanged", async () => {
    callToolMock.mockResolvedValue({ structuredContent: {} });

    await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "raw" });
    expect(transportCtor.mock.calls[0][1].requestInit.headers.Authorization).toBe("Bearer raw");

    transportCtor.mockClear();
    await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "Basic abc==" });
    expect(transportCtor.mock.calls[0][1].requestInit.headers.Authorization).toBe("Basic abc==");
  });

  it("prefers structuredContent over text content", async () => {
    callToolMock.mockResolvedValue({
      structuredContent: { from: "structured" },
      content: [{ type: "text", text: '{"from":"wrong"}' }],
    });
    const out = await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "t" });
    expect(out.from).toBe("structured");
  });

  it("throws on tool-level error result", async () => {
    callToolMock.mockResolvedValue({ isError: true, content: [{ type: "text", text: "boom" }] });
    await expect(
      callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "t" }),
    ).rejects.toThrow(/Marketplace vendor_get_self returned an error: boom/);
  });

  it("closes the client even after a successful call", async () => {
    callToolMock.mockResolvedValue({ structuredContent: {} });
    await callMarketplaceTool("vendor_get_self", {}, { baseUrl: "https://mk.test", token: "t" });
    expect(closeMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveMarketplaceBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("honors MARKETPLACE_BASE_URL override outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MARKETPLACE_BASE_URL", "http://localhost:8081/");
    expect(resolveMarketplaceBaseUrl()).toBe("http://localhost:8081");
  });

  it("ignores override AND env in production (single hardcoded marketplace)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MARKETPLACE_BASE_URL", "http://evil.test");
    expect(resolveMarketplaceBaseUrl("http://also-evil.test")).toBe(MARKETPLACE_BASE_URL);
  });
});
