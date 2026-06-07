// Verifies buildDrupalMcpServerTools +
// getDrupalMcpInstanceStatuses source the Bearer header from the
// Nango vault.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/drupal-api", () => ({
  getDrupalAPISettings: vi.fn(),
}));

vi.mock("@/lib/wordpress-mcp-connection", () => ({
  isPrivateUrl: vi.fn((u: string) => /localhost|127\.0\.0\.1|::1/.test(u)),
}));

vi.mock("@cinatra-ai/nango-connector", () => ({
  buildBearerAuthHeaderFromNango: vi.fn(),
  isNangoConfigured: vi.fn(),
}));

import { getDrupalAPISettings } from "@/lib/drupal-api";
import { buildBearerAuthHeaderFromNango, isNangoConfigured } from "@cinatra-ai/nango-connector";
import { buildDrupalMcpServerTools, getDrupalMcpInstanceStatuses } from "@/lib/drupal-mcp-connection";

const inst = (id: string, siteUrl?: string) => ({
  id,
  name: `Site ${id}`,
  siteUrl: siteUrl ?? `https://site-${id}.example.com`,
  nangoConnectionId: id,
  providerConfigKey: "cinatra-drupal",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isNangoConfigured).mockReturnValue(true);
  // Default Nango success — individual tests override.
  vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValue({ Authorization: "Bearer default-token" });
  // Default fetch: 200 OK so HEAD-probe classify is "registered".
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 } as Response)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("buildDrupalMcpServerTools", () => {
  it("returns [] when Nango is unconfigured and warns once", async () => {
    vi.mocked(isNangoConfigured).mockReturnValue(false);
    vi.mocked(getDrupalAPISettings).mockReturnValue({ instances: [inst("a"), inst("b")] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildDrupalMcpServerTools("openai");

    expect(result).toEqual([]);
    expect(vi.mocked(buildBearerAuthHeaderFromNango)).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] when no instances configured", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({ instances: [] });
    expect(await buildDrupalMcpServerTools("openai")).toEqual([]);
  });

  it("skips private URLs (localhost) — never returned to LLM", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [inst("a", "http://localhost:8082")],
    });
    expect(await buildDrupalMcpServerTools("openai")).toEqual([]);
    // No Nango lookup for private rows — they're skipped first.
    expect(vi.mocked(buildBearerAuthHeaderFromNango)).not.toHaveBeenCalled();
  });

  it("emits one LlmMcpServerTool per instance with Nango-backed Authorization header (no mcpApiKey read)", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({ instances: [inst("a"), inst("b")] });
    vi.mocked(buildBearerAuthHeaderFromNango)
      .mockResolvedValueOnce({ Authorization: "Bearer token-a" })
      .mockResolvedValueOnce({ Authorization: "Bearer token-b" });

    const result = await buildDrupalMcpServerTools("openai");

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "mcp",
      serverLabel: "drupal-a",
      serverUrl: "https://site-a.example.com/_mcp_tools",
      headers: { Authorization: "Bearer token-a" },
    });
    expect(result[1]).toMatchObject({
      type: "mcp",
      serverLabel: "drupal-b",
      headers: { Authorization: "Bearer token-b" },
    });
    expect(vi.mocked(buildBearerAuthHeaderFromNango)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(buildBearerAuthHeaderFromNango)).toHaveBeenCalledWith({
      providerConfigKey: "cinatra-drupal",
      connectionId: "a",
      label: "drupal-a",
    });
  });

  it("skips instances where Nango header lookup returns null", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({ instances: [inst("a"), inst("b")] });
    vi.mocked(buildBearerAuthHeaderFromNango)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ Authorization: "Bearer token-b" });

    const result = await buildDrupalMcpServerTools("openai");

    expect(result).toHaveLength(1);
    expect(result[0].serverLabel).toBe("drupal-b");
  });

  it("classifies HTTP 401 as auth_error → tool not registered", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [inst("a", "https://auth-error.example.com")],
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401 } as Response)));
    expect(await buildDrupalMcpServerTools("openai")).toEqual([]);
  });

  it("treats HTTP 405 as registered (HEAD-not-supported fallback)", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [inst("a", "https://head-not-supported.example.com")],
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 405 } as Response)));
    const tools = await buildDrupalMcpServerTools("openai");
    expect(tools).toHaveLength(1);
  });
});

describe("getDrupalMcpInstanceStatuses — Nango-backed probe", () => {
  // Note: drupal-mcp-connection.ts has a module-level probeCache keyed by
  // `${siteUrl}/_mcp_tools`. Use unique siteUrls here to avoid bleed from
  // the buildDrupalMcpServerTools tests above (which also probe).

  it("classifies unreachable when Nango credential is missing (no token in response)", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [inst("status-missing-cred", "https://status-missing.example.com")],
    });
    vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValueOnce(null);

    const statuses = await getDrupalMcpInstanceStatuses();

    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe("unreachable");
    expect(JSON.stringify(statuses[0])).not.toContain("Bearer");
  });

  it("issues HEAD probe with the Nango-resolved Authorization header", async () => {
    vi.mocked(getDrupalAPISettings).mockReturnValue({
      instances: [inst("status-ok", "https://status-ok.example.com")],
    });
    vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValueOnce({ Authorization: "Bearer token-a" });

    const statuses = await getDrupalMcpInstanceStatuses();

    expect(statuses[0].status).toBe("registered");
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "https://status-ok.example.com/_mcp_tools",
      expect.objectContaining({ method: "HEAD", headers: { Authorization: "Bearer token-a" } }),
    );
  });
});
