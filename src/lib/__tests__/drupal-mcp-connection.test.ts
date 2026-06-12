// Verifies getDrupalMcpInstanceStatuses + probeDrupalMcp source the Bearer
// header from the Nango vault (via the host shim @/lib/nango) and classify
// probe responses correctly. The LLM toolbox BUILDER that used to live in
// @/lib/drupal-mcp-connection moved into the drupal-mcp-connector extension
// (src/mcp/toolbox.ts) — its tests live there now.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/drupal-api", () => ({
  getDrupalAPISettings: vi.fn(),
}));

vi.mock("@/lib/wordpress-mcp-connection", () => ({
  isPrivateUrl: vi.fn((u: string) => /localhost|127\.0\.0\.1|::1/.test(u)),
}));

vi.mock("@/lib/nango-system", () => ({
  buildBearerAuthHeaderFromNango: vi.fn(),
}));

import { getDrupalAPISettings } from "@/lib/drupal-api";
import { buildBearerAuthHeaderFromNango } from "@/lib/nango-system";
import {
  getDrupalMcpInstanceStatuses,
  probeDrupalMcp,
  resolveDrupalMcpServerUrl,
} from "@/lib/drupal-mcp-connection";

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
  // Default Nango success — individual tests override.
  vi.mocked(buildBearerAuthHeaderFromNango).mockResolvedValue({ Authorization: "Bearer default-token" });
  // Default fetch: 200 OK so HEAD-probe classify is "registered".
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 } as Response)));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveDrupalMcpServerUrl", () => {
  it("appends the MCP route to the trimmed site URL", () => {
    expect(resolveDrupalMcpServerUrl("https://site.example.com/")).toBe(
      "https://site.example.com/_mcp_tools",
    );
  });
});

describe("probeDrupalMcp — classification", () => {
  // Note: drupal-mcp-connection.ts has a module-level probeCache keyed by
  // the resolved endpoint. Use unique siteUrls per test to avoid bleed.

  it("classifies HTTP 401 as auth_error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401 } as Response)));
    expect(await probeDrupalMcp("https://probe-401.example.com", "Bearer t")).toBe("auth_error");
  });

  it("treats HTTP 405 as registered (HEAD-not-supported fallback)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 405 } as Response)));
    expect(await probeDrupalMcp("https://probe-405.example.com", "Bearer t")).toBe("registered");
  });
});

describe("getDrupalMcpInstanceStatuses — Nango-backed probe", () => {
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
